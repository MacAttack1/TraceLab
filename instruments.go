package main

// Bench instruments: multimeters, bench power supplies and oscilloscopes connected over USB serial
// (COM ports), USB through VISA (USBTMC), or the network (raw SCPI on port 5025). Each connected
// instrument is polled in the background; the UI shows live readouts and the repair assistant reads
// the same values, takes fresh measurements, grabs scope screens and sees recent history (e.g. the
// supply's current draw while the board powers on).
//
// Control is deliberately limited to switching the meter's function. Supply outputs and setpoints are
// read-only: the assistant must never be able to put voltage on a board.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type rawPort interface {
	io.Reader // returns 0, nil when nothing arrives within a short timeout
	io.Writer
	io.Closer
}

type portInfo struct {
	Port string `json:"port"`
	Desc string `json:"desc"`
}

// InstCfg is one configured instrument, persisted in config.json.
type InstCfg struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`    // dmm | psu | scope
	Name     string `json:"name"`    // shown on the bench, e.g. "Bench meter"
	Profile  string `json:"profile"` // key into instProfiles
	Conn     string `json:"conn"`    // serial | visa | lan | demo
	Addr     string `json:"addr"`    // COM5, USB0::…::INSTR, 192.168.1.50[:5025]
	Baud     int    `json:"baud"`
	Channel  int    `json:"channel"`  // supply channel
	Channels string `json:"channels"` // scope channels to measure, e.g. "1,2"
	Show     bool   `json:"show"`     // live card visible on the bench
	Auto     bool   `json:"auto"`     // reconnect when Trace Lab starts
}

type instProfile struct {
	Kind  string            `json:"kind"`
	Label string            `json:"label"`
	Conns []string          `json:"conns"`
	Baud  int               `json:"baud"`
	Term  string            `json:"-"` // appended to every command
	Raw   bool              `json:"-"` // replies have no terminator (frame by idle time)
	Proto string            `json:"-"` // scpi | qm | stream | korad | demo
	Cmd   map[string]string `json:"-"`
	Items map[string]string `json:"-"` // scope: our item name -> vendor's
	Shot  string            `json:"-"` // scope screenshot reply: block | bmp
	Modes []string          `json:"modes,omitempty"`
	Note  string            `json:"note,omitempty"`
}

var dmmModes = []string{"dcv", "acv", "res", "diode", "cont"}

var instProfiles = map[string]*instProfile{
	"dmm-scpi": {Kind: "dmm", Label: "SCPI bench meter (Keysight 344xx, Siglent SDM, Rigol DM3000, GW Instek GDM)", Conns: []string{"visa", "lan", "serial"}, Baud: 9600, Term: "\n", Proto: "scpi", Modes: dmmModes,
		Cmd: map[string]string{"idn": "*IDN?", "func": "FUNC?", "read": "READ?", "dcv": "CONF:VOLT:DC", "acv": "CONF:VOLT:AC", "res": "CONF:RES", "diode": "CONF:DIOD", "cont": "CONF:CONT"}},
	"dmm-owon": {Kind: "dmm", Label: "Owon XDM series (XDM1041, XDM1241, XDM2041)", Conns: []string{"serial", "lan"}, Baud: 115200, Term: "\n", Proto: "scpi", Modes: dmmModes,
		Cmd: map[string]string{"idn": "*IDN?", "func": "FUNC?", "read": "MEAS1?", "dcv": "CONF:VOLT:DC", "acv": "CONF:VOLT:AC", "res": "CONF:RES", "diode": "CONF:DIOD", "cont": "CONF:CONT"}},
	"dmm-fluke": {Kind: "dmm", Label: "Fluke 287 / 289 (IR USB cable)", Conns: []string{"serial"}, Baud: 115200, Term: "\r", Proto: "qm",
		Cmd: map[string]string{"idn": "ID", "read": "QM"}, Note: "Set the function with the meter's rotary switch."},
	"dmm-stream": {Kind: "dmm", Label: "Meter or adapter that sends text readings (one per line)", Conns: []string{"serial", "lan"}, Baud: 9600, Proto: "stream",
		Note: "For meters and USB adapters that print readings like \"3.312 V\" on their own. Set the function on the meter."},
	"dmm-demo": {Kind: "dmm", Label: "Demo multimeter (simulated)", Conns: []string{"demo"}, Proto: "demo", Modes: dmmModes},

	"psu-scpi": {Kind: "psu", Label: "SCPI supply, single output (Owon SPE/SPM, Keysight E36xx, B&K, Korad KWR)", Conns: []string{"serial", "visa", "lan"}, Baud: 115200, Term: "\n", Proto: "scpi",
		Cmd: map[string]string{"idn": "*IDN?", "volts": "MEAS:VOLT?", "amps": "MEAS:CURR?", "vset": "VOLT?", "iset": "CURR?", "out": "OUTP?"}},
	"psu-rigol": {Kind: "psu", Label: "Rigol DP800 (DP811, DP821, DP831, DP832)", Conns: []string{"visa", "lan", "serial"}, Baud: 9600, Term: "\n", Proto: "scpi",
		Cmd: map[string]string{"idn": "*IDN?", "volts": ":MEAS:VOLT? CH{ch}", "amps": ":MEAS:CURR? CH{ch}", "vset": ":SOUR{ch}:VOLT?", "iset": ":SOUR{ch}:CURR?", "out": ":OUTP? CH{ch}", "mode": ":OUTP:MODE? CH{ch}"}},
	"psu-siglent": {Kind: "psu", Label: "Siglent SPD3303 / SPD1000", Conns: []string{"visa", "lan"}, Term: "\n", Proto: "scpi",
		Cmd: map[string]string{"idn": "*IDN?", "volts": "MEAS:VOLT? CH{ch}", "amps": "MEAS:CURR? CH{ch}", "vset": "CH{ch}:VOLT?", "iset": "CH{ch}:CURR?"}},
	"psu-korad": {Kind: "psu", Label: "Korad / Tenma / Velleman (KA3005P, 72-2540, PS3005D)", Conns: []string{"serial"}, Baud: 9600, Raw: true, Proto: "korad",
		Cmd: map[string]string{"idn": "*IDN?", "volts": "VOUT{ch}?", "amps": "IOUT{ch}?", "vset": "VSET{ch}?", "iset": "ISET{ch}?", "status": "STATUS?"}},
	"psu-demo": {Kind: "psu", Label: "Demo power supply (simulated)", Conns: []string{"demo"}, Proto: "demo"},

	"scope-rigol": {Kind: "scope", Label: "Rigol DS1000Z / MSO5000 / DHO", Conns: []string{"visa", "lan"}, Term: "\n", Proto: "scpi", Shot: "block",
		Cmd:   map[string]string{"idn": "*IDN?", "meas": ":MEAS:ITEM? {item},CHAN{ch}", "shot": ":DISP:DATA? ON,OFF,PNG"},
		Items: map[string]string{"vpp": "VPP", "vmax": "VMAX", "vmin": "VMIN", "vavg": "VAVG", "freq": "FREQ"}},
	"scope-siglent": {Kind: "scope", Label: "Siglent SDS (SDS1104X-E, SDS1202X-E, SDS2000X)", Conns: []string{"visa", "lan"}, Term: "\n", Proto: "scpi", Shot: "bmp",
		Cmd:   map[string]string{"idn": "*IDN?", "meas": "C{ch}:PAVA? {item}", "shot": "SCDP"},
		Items: map[string]string{"vpp": "PKPK", "vmax": "MAX", "vmin": "MIN", "vavg": "MEAN", "freq": "FREQ"}},
	"scope-keysight": {Kind: "scope", Label: "Keysight InfiniiVision / generic SCPI scope", Conns: []string{"visa", "lan"}, Term: "\n", Proto: "scpi", Shot: "block",
		Cmd:   map[string]string{"idn": "*IDN?", "meas": ":MEAS:{item}? CHAN{ch}", "shot": ":DISP:DATA? PNG,COL"},
		Items: map[string]string{"vpp": "VPP", "vmax": "VMAX", "vmin": "VMIN", "vavg": "VAV", "freq": "FREQ"}},
	"scope-demo": {Kind: "scope", Label: "Demo oscilloscope (simulated)", Conns: []string{"demo"}, Proto: "demo", Shot: "demo"},
}

// ---- live state ----

type meterReading struct {
	Mode  string  `json:"mode"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
	OL    bool    `json:"ol"`
	Text  string  `json:"text"`
}

type psuReading struct {
	Volts  float64  `json:"volts"`
	Amps   float64  `json:"amps"`
	Watts  float64  `json:"watts"`
	VSet   *float64 `json:"vset,omitempty"`
	ISet   *float64 `json:"iset,omitempty"`
	Output *bool    `json:"output,omitempty"`
	CC     *bool    `json:"cc,omitempty"`
	Text   string   `json:"text"`
}

type scopeReading struct {
	Channels map[string]map[string]float64 `json:"channels"`
	Text     string                        `json:"text"`
}

type sample struct {
	T int64   `json:"t"`
	V float64 `json:"v"`           // meter value, or supply current
	W float64 `json:"w,omitempty"` // supply voltage
}

type instState struct {
	Status  string        `json:"status"` // off | connecting | connected | error
	Error   string        `json:"error,omitempty"`
	IDN     string        `json:"idn,omitempty"`
	Meter   *meterReading `json:"meter,omitempty"`
	PSU     *psuReading   `json:"psu,omitempty"`
	Scope   *scopeReading `json:"scope,omitempty"`
	Updated int64         `json:"updated,omitempty"`
}

type instrument struct {
	cfg  InstCfg
	prof *instProfile

	io     sync.Mutex // serialises traffic on the port
	port   rawPort
	dirty  bool // a reply was late; drain before the next command
	stream chan string

	smu   sync.Mutex
	st    instState
	hist  []sample
	stop  chan struct{}
	mode  string // meter function we last set or saw
	lastF time.Time
	shot  []byte // last screenshot (PNG)
	demo  demoSim
}

var bench = struct {
	sync.Mutex
	m map[string]*instrument
}{m: map[string]*instrument{}}

// ---- port helpers ----

type tcpPort struct{ c net.Conn }

func (t *tcpPort) Read(b []byte) (int, error) {
	_ = t.c.SetReadDeadline(time.Now().Add(60 * time.Millisecond))
	n, err := t.c.Read(b)
	var ne net.Error
	if err != nil && errors.As(err, &ne) && ne.Timeout() {
		return n, nil
	}
	return n, err
}
func (t *tcpPort) Write(b []byte) (int, error) {
	_ = t.c.SetWriteDeadline(time.Now().Add(3 * time.Second))
	return t.c.Write(b)
}
func (t *tcpPort) Close() error { return t.c.Close() }

func openPort(c InstCfg, p *instProfile) (rawPort, error) {
	switch c.Conn {
	case "serial":
		if c.Addr == "" {
			return nil, errors.New("choose a COM port")
		}
		b := c.Baud
		if b == 0 {
			b = p.Baud
		}
		return openSerial(c.Addr, b)
	case "visa":
		if c.Addr == "" {
			return nil, errors.New("choose a USB instrument")
		}
		return openVISA(c.Addr)
	case "lan":
		a := strings.TrimSpace(c.Addr)
		if a == "" {
			return nil, errors.New("enter the instrument's IP address")
		}
		if _, _, err := net.SplitHostPort(a); err != nil {
			a = net.JoinHostPort(a, "5025") // raw SCPI socket used by Rigol, Siglent, Keysight, Owon
		}
		cn, err := net.DialTimeout("tcp", a, 3*time.Second)
		if err != nil {
			return nil, fmt.Errorf("couldn't reach %s: %v. Check the IP address on the instrument's LAN/IO page", a, err)
		}
		return &tcpPort{c: cn}, nil
	case "demo":
		return nil, nil
	}
	return nil, fmt.Errorf("unknown connection type %q", c.Conn)
}

func (in *instrument) cmd(key string) string {
	s := in.prof.Cmd[key]
	ch := in.cfg.Channel
	if ch <= 0 {
		ch = 1
	}
	return strings.ReplaceAll(s, "{ch}", strconv.Itoa(ch))
}

func (in *instrument) drain() {
	buf := make([]byte, 4096)
	for i := 0; i < 20; i++ {
		n, err := in.port.Read(buf)
		if n == 0 || err != nil {
			return
		}
	}
}

// query writes a command and reads one reply. Caller holds in.io.
func (in *instrument) query(c string, timeout time.Duration) (string, error) {
	if in.port == nil {
		return "", errors.New("not connected")
	}
	if in.dirty {
		in.drain()
		in.dirty = false
	}
	if _, err := in.port.Write([]byte(c + in.prof.Term)); err != nil {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	var got []byte
	buf := make([]byte, 1024)
	for time.Now().Before(deadline) {
		n, err := in.port.Read(buf)
		if err != nil {
			return "", err
		}
		got = append(got, buf[:n]...)
		if in.prof.Raw {
			if n == 0 && len(got) > 0 {
				return strings.TrimSpace(string(got)), nil
			}
			continue
		}
		if in.prof.Proto == "qm" { // Fluke: "0\r" acknowledgement, then the reading line
			lines := strings.Split(strings.ReplaceAll(string(got), "\n", "\r"), "\r")
			if len(lines) >= 3 || (len(lines) == 2 && lines[0] != "0" && lines[0] != "") {
				return strings.TrimSpace(strings.Join(lines, "\r")), nil
			}
			continue
		}
		if i := bytes.IndexByte(got, '\n'); i >= 0 {
			return strings.TrimSpace(string(got[:i])), nil
		}
	}
	in.dirty = true
	if len(got) > 0 {
		return strings.TrimSpace(string(got)), nil
	}
	return "", fmt.Errorf("no reply to %q", c)
}

func (in *instrument) write(c string) error {
	if in.port == nil {
		return errors.New("not connected")
	}
	_, err := in.port.Write([]byte(c + in.prof.Term))
	return err
}

// queryBlock reads a binary reply: an IEEE 488.2 block (#<n><len><data>) or a raw BMP.
func (in *instrument) queryBlock(c string) ([]byte, error) {
	if err := in.write(c); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(20 * time.Second)
	var got []byte
	buf := make([]byte, 65536)
	want := -1
	for time.Now().Before(deadline) {
		n, err := in.port.Read(buf)
		if err != nil {
			return nil, err
		}
		got = append(got, buf[:n]...)
		if want < 0 {
			if i := bytes.IndexByte(got, '#'); i >= 0 && len(got) > i+2 && (len(got) < 2 || string(got[:2]) != "BM") {
				nd := int(got[i+1] - '0')
				if nd > 0 && len(got) >= i+2+nd {
					l, _ := strconv.Atoi(string(got[i+2 : i+2+nd]))
					got = got[i+2+nd:]
					want = l
				}
			} else if i := bytes.Index(got, []byte("BM")); i >= 0 && len(got) >= i+6 {
				got = got[i:]
				want = int(binary.LittleEndian.Uint32(got[2:6]))
			}
		}
		if want >= 0 && len(got) >= want {
			in.dirty = true // trailing newline
			return got[:want], nil
		}
	}
	in.dirty = true
	return nil, errors.New("the screenshot didn't arrive in time")
}

// ---- parsing ----

var numRe = regexp.MustCompile(`[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?`)

func parseNum(s string) (float64, bool) {
	m := numRe.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(m, 64)
	return v, err == nil
}

func funcMode(s string) string {
	u := strings.ToUpper(strings.Trim(strings.TrimSpace(s), "\""))
	switch {
	case strings.Contains(u, "DIOD"):
		return "diode"
	case strings.Contains(u, "CONT"):
		return "cont"
	case strings.Contains(u, "RES"):
		return "res"
	case strings.Contains(u, "CAP"):
		return "cap"
	case strings.Contains(u, "FREQ"):
		return "freq"
	case strings.Contains(u, "TEMP"):
		return "temp"
	case strings.Contains(u, "CURR") && strings.Contains(u, "AC"):
		return "aca"
	case strings.Contains(u, "CURR"):
		return "dca"
	case strings.Contains(u, "VOLT") && strings.Contains(u, "AC"):
		return "acv"
	case strings.Contains(u, "VOLT"):
		return "dcv"
	}
	return ""
}

var modeUnit = map[string]string{"dcv": "V", "acv": "V AC", "res": "Ω", "diode": "V", "cont": "Ω", "dca": "A", "aca": "A AC", "cap": "F", "freq": "Hz", "temp": "°C"}
var ModeLabel = map[string]string{"dcv": "DC volts", "acv": "AC volts", "res": "Resistance", "diode": "Diode", "cont": "Continuity", "dca": "DC amps", "aca": "AC amps", "cap": "Capacitance", "freq": "Frequency", "temp": "Temperature"}

func eng(v float64, unit string) string {
	a := math.Abs(v)
	type pf struct {
		m float64
		p string
	}
	pick := pf{1, ""}
	if a > 0 {
		for _, x := range []pf{{1e9, "G"}, {1e6, "M"}, {1e3, "k"}, {1, ""}, {1e-3, "m"}, {1e-6, "µ"}, {1e-9, "n"}, {1e-12, "p"}} {
			pick = x
			if a >= x.m*0.9995 {
				break
			}
		}
	}
	f := v / pick.m
	d := 3
	if math.Abs(f) >= 100 {
		d = 1
	} else if math.Abs(f) >= 10 {
		d = 2
	}
	return strconv.FormatFloat(f, 'f', d, 64) + " " + pick.p + unit
}

func meterText(r *meterReading) string {
	if r.OL {
		return "OL"
	}
	switch r.Mode {
	case "diode":
		return strconv.FormatFloat(r.Value, 'f', 3, 64) + " V"
	case "dcv", "acv":
		if math.Abs(r.Value) < 1 && r.Value != 0 {
			return eng(r.Value, strings.TrimPrefix(r.Unit, ""))
		}
		return strconv.FormatFloat(r.Value, 'f', 3, 64) + " " + r.Unit
	case "", "unknown":
		return strconv.FormatFloat(r.Value, 'g', 6, 64) + " " + r.Unit
	}
	return eng(r.Value, r.Unit)
}

func isOL(v float64, raw string) bool {
	u := strings.ToUpper(raw)
	return math.Abs(v) >= 9e37 || strings.Contains(u, "OL") || strings.Contains(u, "OVLD") || strings.Contains(u, "OVER")
}

var qmUnits = map[string]string{"VDC": "dcv", "VAC": "acv", "V": "dcv", "OHM": "res", "ADC": "dca", "AAC": "aca", "F": "cap", "HZ": "freq", "CEL": "temp", "S": "cont"}

// parseStreamLine reads "3.312 V", "-0.004VDC", "12.5 kOhm", "0.452" and similar.
func parseStreamLine(s string, last string) (*meterReading, bool) {
	v, ok := parseNum(s)
	if !ok {
		return nil, false
	}
	u := strings.ToUpper(s)
	mode, mult := last, 1.0
	switch {
	case strings.Contains(u, "MV"):
		mult, mode = 1e-3, "dcv"
	case strings.Contains(u, "KΩ") || strings.Contains(u, "KOHM"):
		mult, mode = 1e3, "res"
	case strings.Contains(u, "MΩ") || strings.Contains(u, "MOHM"):
		mult, mode = 1e6, "res"
	case strings.Contains(u, "Ω") || strings.Contains(u, "OHM"):
		mode = "res"
	case strings.Contains(u, "MA"):
		mult, mode = 1e-3, "dca"
	case strings.Contains(u, "VAC") || strings.Contains(u, "V AC"):
		mode = "acv"
	case strings.Contains(u, "V"):
		mode = "dcv"
	case strings.Contains(u, "A"):
		mode = "dca"
	}
	if mode == "" {
		mode = "unknown"
	}
	r := &meterReading{Mode: mode, Value: v * mult, Unit: modeUnit[mode], OL: isOL(v, s)}
	return r, true
}

// ---- connection lifecycle ----

func (in *instrument) setState(f func(s *instState)) {
	in.smu.Lock()
	f(&in.st)
	in.smu.Unlock()
}

func (in *instrument) state() instState {
	in.smu.Lock()
	defer in.smu.Unlock()
	return in.st
}

func (in *instrument) push(s sample) {
	in.smu.Lock()
	in.hist = append(in.hist, s)
	if len(in.hist) > 1200 {
		in.hist = in.hist[len(in.hist)-1000:]
	}
	in.smu.Unlock()
}

func (in *instrument) connect() error {
	in.io.Lock()
	if in.port != nil || in.stop != nil {
		in.io.Unlock()
		return nil
	}
	in.setState(func(s *instState) { s.Status, s.Error = "connecting", "" })
	p, err := openPort(in.cfg, in.prof)
	if err != nil {
		in.io.Unlock()
		in.setState(func(s *instState) { s.Status, s.Error = "error", err.Error() })
		return err
	}
	in.port = p
	idn := ""
	switch in.prof.Proto {
	case "demo":
		idn = "Trace Lab," + strings.ToUpper(in.cfg.Kind) + " simulator,0,1.0"
		in.demo.init(in.cfg.Kind)
	case "stream":
		idn = "Text reading stream on " + in.cfg.Addr
	default:
		if c := in.cmd("idn"); c != "" {
			if r, err := in.query(c, 1500*time.Millisecond); err == nil {
				idn = strings.TrimSpace(strings.TrimPrefix(r, "0\r"))
			}
		}
	}
	in.io.Unlock()
	// Prove the link with one real reading before calling it connected.
	if err := in.poll(true); err != nil && in.prof.Proto != "stream" {
		in.close()
		msg := err.Error()
		if idn == "" {
			msg += ". Check the model, port and baud rate"
		}
		in.setState(func(s *instState) { s.Status, s.Error = "error", msg })
		return errors.New(msg)
	}
	in.setState(func(s *instState) { s.Status, s.Error, s.IDN = "connected", "", idn })
	in.stop = make(chan struct{})
	if in.prof.Proto == "stream" {
		go in.streamLoop(in.stop)
	}
	go in.pollLoop(in.stop)
	return nil
}

func (in *instrument) close() {
	in.io.Lock()
	if in.stop != nil {
		close(in.stop)
		in.stop = nil
	}
	if in.port != nil {
		_ = in.port.Close()
		in.port = nil
	}
	in.io.Unlock()
	in.setState(func(s *instState) {
		if s.Status != "error" {
			s.Status = "off"
		}
	})
}

func (in *instrument) pollLoop(stop chan struct{}) {
	every := map[string]time.Duration{"dmm": 300 * time.Millisecond, "psu": 400 * time.Millisecond, "scope": 1500 * time.Millisecond}[in.cfg.Kind]
	fails := 0
	for {
		select {
		case <-stop:
			return
		case <-time.After(every):
		}
		if err := in.poll(false); err != nil {
			fails++
			if fails >= 5 {
				in.setState(func(s *instState) { s.Status, s.Error = "error", "Lost the connection: "+err.Error() })
				go in.close()
				return
			}
		} else {
			fails = 0
			in.setState(func(s *instState) {
				if s.Status == "error" {
					s.Status, s.Error = "connected", ""
				}
			})
		}
	}
}

func (in *instrument) streamLoop(stop chan struct{}) {
	buf := make([]byte, 512)
	var line []byte
	for {
		select {
		case <-stop:
			return
		default:
		}
		in.io.Lock()
		p := in.port
		var n int
		var err error
		if p != nil {
			n, err = p.Read(buf)
		}
		in.io.Unlock()
		if p == nil || err != nil {
			return
		}
		if n == 0 {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		for _, c := range buf[:n] {
			if c == '\n' || c == '\r' {
				if len(line) > 0 {
					if r, ok := parseStreamLine(string(line), in.mode); ok {
						in.mode = r.Mode
						r.Text = meterText(r)
						now := time.Now().UnixMilli()
						in.setState(func(s *instState) { s.Meter, s.Updated, s.Status = r, now, "connected" })
						if !r.OL {
							in.push(sample{T: now, V: r.Value})
						}
					}
				}
				line = line[:0]
			} else if len(line) < 200 {
				line = append(line, c)
			}
		}
	}
}

// poll takes one reading of whatever the instrument shows. full also refreshes slow-changing values.
func (in *instrument) poll(full bool) error {
	in.io.Lock()
	defer in.io.Unlock()
	if in.port == nil && in.prof.Proto != "demo" {
		if in.prof.Proto == "stream" {
			return nil
		}
		return errors.New("not connected")
	}
	now := time.Now()
	switch in.cfg.Kind {
	case "dmm":
		return in.pollMeter(now, full)
	case "psu":
		return in.pollPSU(now, full)
	case "scope":
		return in.pollScope(now)
	}
	return nil
}

func (in *instrument) pollMeter(now time.Time, full bool) error {
	r := &meterReading{}
	switch in.prof.Proto {
	case "stream":
		return nil
	case "demo":
		if in.mode == "" {
			in.mode = "dcv"
		}
		r.Mode = in.mode
		r.Value, r.OL = in.demo.meter(in.mode)
	case "qm":
		s, err := in.query(in.cmd("read"), 1200*time.Millisecond)
		if err != nil {
			return err
		}
		lines := strings.Split(s, "\r")
		data := lines[len(lines)-1]
		f := strings.Split(data, ",")
		if len(f) < 2 {
			return fmt.Errorf("unexpected reply %q", s)
		}
		v, _ := parseNum(f[0])
		r.Mode = qmUnits[strings.ToUpper(strings.TrimSpace(f[1]))]
		if r.Mode == "" {
			r.Mode = "unknown"
		}
		r.Value, r.OL = v, isOL(v, data)
		if len(f) > 3 && strings.Contains(strings.ToUpper(f[3]), "DIODE") {
			r.Mode = "diode"
		}
		in.mode = r.Mode
	default:
		if c := in.cmd("func"); c != "" && (full || in.mode == "" || now.Sub(in.lastF) > 2*time.Second) {
			if s, err := in.query(c, 800*time.Millisecond); err == nil {
				if m := funcMode(s); m != "" {
					in.mode = m
				}
				in.lastF = now
			}
		}
		s, err := in.query(in.cmd("read"), 3*time.Second)
		if err != nil {
			return err
		}
		v, ok := parseNum(s)
		if !ok {
			return fmt.Errorf("unexpected reply %q", s)
		}
		r.Mode = in.mode
		if r.Mode == "" {
			r.Mode = "unknown"
		}
		r.Value, r.OL = v, isOL(v, s)
	}
	r.Unit = modeUnit[r.Mode]
	r.Text = meterText(r)
	t := now.UnixMilli()
	in.setState(func(s *instState) { s.Meter, s.Updated = r, t })
	if !r.OL {
		in.push(sample{T: t, V: r.Value})
	}
	return nil
}

func (in *instrument) num(key string) (*float64, error) {
	c := in.cmd(key)
	if c == "" {
		return nil, nil
	}
	s, err := in.query(c, 1500*time.Millisecond)
	if err != nil {
		return nil, err
	}
	v, ok := parseNum(s)
	if !ok {
		return nil, fmt.Errorf("unexpected reply %q to %s", s, c)
	}
	return &v, nil
}

func (in *instrument) pollPSU(now time.Time, full bool) error {
	prev := in.state().PSU
	r := &psuReading{}
	if in.prof.Proto == "demo" {
		d := in.demo.psu()
		r.Volts, r.Amps, r.VSet, r.ISet, r.Output, r.CC = d.Volts, d.Amps, d.VSet, d.ISet, d.Output, d.CC
	} else {
		v, err := in.num("volts")
		if err != nil {
			return err
		}
		a, err := in.num("amps")
		if err != nil {
			return err
		}
		r.Volts, r.Amps = *v, *a
		if full || prev == nil || now.Sub(in.lastF) > 2*time.Second {
			in.lastF = now
			r.VSet, _ = in.num("vset")
			r.ISet, _ = in.num("iset")
			if c := in.cmd("out"); c != "" {
				if s, err := in.query(c, time.Second); err == nil {
					on := strings.Contains(strings.ToUpper(s), "ON") || strings.TrimSpace(s) == "1"
					r.Output = &on
				}
			}
			if c := in.cmd("mode"); c != "" {
				if s, err := in.query(c, time.Second); err == nil {
					cc := strings.Contains(strings.ToUpper(s), "CC")
					r.CC = &cc
				}
			}
			if c := in.cmd("status"); c != "" { // Korad: bit0 = CH1 CV(1)/CC(0), bit6 = output on
				if s, err := in.query(c, time.Second); err == nil && len(s) > 0 {
					b := s[0]
					on, cc := b&0x40 != 0, b&0x01 == 0
					r.Output, r.CC = &on, &cc
				}
			}
		} else if prev != nil {
			r.VSet, r.ISet, r.Output, r.CC = prev.VSet, prev.ISet, prev.Output, prev.CC
		}
	}
	r.Watts = r.Volts * r.Amps
	r.Text = fmt.Sprintf("%.3f V  %.4f A  (%.2f W)", r.Volts, r.Amps, r.Watts)
	if r.Output != nil && !*r.Output {
		r.Text += "  output OFF"
	}
	if r.CC != nil && *r.CC && (r.Output == nil || *r.Output) {
		r.Text += "  CURRENT LIMITING (CC)"
	}
	t := now.UnixMilli()
	in.setState(func(s *instState) { s.PSU, s.Updated = r, t })
	in.push(sample{T: t, V: r.Amps, W: r.Volts})
	return nil
}

func (in *instrument) scopeChannels() []string {
	var out []string
	for _, c := range strings.Split(in.cfg.Channels, ",") {
		if c = strings.TrimSpace(c); c != "" {
			out = append(out, c)
		}
	}
	if len(out) == 0 {
		out = []string{"1"}
	}
	return out
}

func (in *instrument) scopeMeasure(chs []string, items []string) (map[string]map[string]float64, error) {
	res := map[string]map[string]float64{}
	for _, ch := range chs {
		res[ch] = map[string]float64{}
		for _, it := range items {
			if in.prof.Proto == "demo" {
				res[ch][it] = in.demo.scope(ch, it)
				continue
			}
			vend := in.prof.Items[it]
			if vend == "" {
				continue
			}
			c := strings.NewReplacer("{ch}", ch, "{item}", vend).Replace(in.prof.Cmd["meas"])
			s, err := in.query(c, 2*time.Second)
			if err != nil {
				return nil, err
			}
			if i := strings.LastIndex(s, ","); i >= 0 && strings.Contains(s, "PAVA") { // Siglent: "C1:PAVA PKPK,2.04E+00V"
				s = s[i+1:]
			}
			v, ok := parseNum(s)
			if !ok || math.Abs(v) >= 9e37 || strings.Contains(s, "****") {
				continue // no valid measurement (no signal)
			}
			res[ch][it] = v
		}
	}
	return res, nil
}

func scopeText(m map[string]map[string]float64) string {
	var parts []string
	for _, ch := range sortedKeys(m) {
		v := m[ch]
		s := "CH" + ch + ":"
		if len(v) == 0 {
			parts = append(parts, s+" no signal")
			continue
		}
		if x, ok := v["vpp"]; ok {
			s += " Vpp " + eng(x, "V")
		}
		if x, ok := v["vavg"]; ok {
			s += ", avg " + eng(x, "V")
		}
		if x, ok := v["vmax"]; ok {
			s += ", max " + eng(x, "V")
		}
		if x, ok := v["vmin"]; ok {
			s += ", min " + eng(x, "V")
		}
		if x, ok := v["freq"]; ok && x > 0 {
			s += ", " + eng(x, "Hz")
		}
		parts = append(parts, s)
	}
	return strings.Join(parts, "  ·  ")
}

func sortedKeys(m map[string]map[string]float64) []string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	for i := range k {
		for j := i + 1; j < len(k); j++ {
			if k[j] < k[i] {
				k[i], k[j] = k[j], k[i]
			}
		}
	}
	return k
}

func (in *instrument) pollScope(now time.Time) error {
	m, err := in.scopeMeasure(in.scopeChannels(), []string{"vpp", "vavg", "freq"})
	if err != nil {
		return err
	}
	r := &scopeReading{Channels: m, Text: scopeText(m)}
	t := now.UnixMilli()
	in.setState(func(s *instState) { s.Scope, s.Updated = r, t })
	return nil
}

func (in *instrument) setMeterMode(mode string) error {
	if in.cfg.Kind != "dmm" {
		return errors.New("only a multimeter has functions to switch")
	}
	if in.prof.Proto == "demo" {
		in.io.Lock()
		in.mode = mode
		in.demo.reset()
		in.io.Unlock()
		return nil
	}
	c := in.prof.Cmd[mode]
	if c == "" {
		return fmt.Errorf("Trace Lab can't switch this meter to %s remotely: turn its dial", ModeLabel[mode])
	}
	in.io.Lock()
	defer in.io.Unlock()
	if err := in.write(c); err != nil {
		return err
	}
	in.mode, in.lastF = mode, time.Now()
	time.Sleep(250 * time.Millisecond)
	return nil
}

func (in *instrument) screenshot() ([]byte, error) {
	if in.cfg.Kind != "scope" {
		return nil, errors.New("screenshots come from an oscilloscope")
	}
	in.io.Lock()
	defer in.io.Unlock()
	var data []byte
	var err error
	if in.prof.Shot == "demo" {
		data = in.demo.screen()
	} else {
		if in.port == nil {
			return nil, errors.New("not connected")
		}
		data, err = in.queryBlock(in.prof.Cmd["shot"])
		if err != nil {
			return nil, err
		}
		if len(data) > 2 && string(data[:2]) == "BM" {
			if data, err = bmpToPNG(data); err != nil {
				return nil, err
			}
		}
	}
	in.smu.Lock()
	in.shot = data
	in.smu.Unlock()
	return data, nil
}

// bmpToPNG converts the uncompressed 24/32-bit BMP that Siglent scopes send.
func bmpToPNG(b []byte) ([]byte, error) {
	if len(b) < 54 {
		return nil, errors.New("short BMP")
	}
	off := int(binary.LittleEndian.Uint32(b[10:14]))
	w := int(int32(binary.LittleEndian.Uint32(b[18:22])))
	h := int(int32(binary.LittleEndian.Uint32(b[22:26])))
	bpp := int(binary.LittleEndian.Uint16(b[28:30]))
	if bpp != 24 && bpp != 32 || w <= 0 || w > 8000 {
		return nil, fmt.Errorf("unsupported BMP (%d bpp)", bpp)
	}
	flip := h > 0
	if h < 0 {
		h = -h
	}
	stride := (w*bpp/8 + 3) &^ 3
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		row := off + y*stride
		dy := y
		if flip {
			dy = h - 1 - y
		}
		for x := 0; x < w; x++ {
			i := row + x*bpp/8
			if i+2 >= len(b) {
				break
			}
			img.Set(x, dy, color.RGBA{b[i+2], b[i+1], b[i], 255})
		}
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// ---- demo instruments (no hardware needed; also used by the tests) ----

type demoSim struct {
	mu     sync.Mutex
	rng    *rand.Rand
	start  time.Time
	target string // net being probed, set by the probe workflow
	touch  time.Time
}

var demoHint = struct {
	sync.Mutex
	net string
	at  time.Time
}{}

func (d *demoSim) init(kind string) {
	d.mu.Lock()
	d.rng = rand.New(rand.NewSource(time.Now().UnixNano()))
	d.start = time.Now()
	d.mu.Unlock()
}
func (d *demoSim) reset() { d.mu.Lock(); d.touch = time.Now(); d.mu.Unlock() }

var railRe = regexp.MustCompile(`(\d+)V(\d+)?`)

// demoValue gives a plausible reading for a net name so the guided workflow can be tried without a meter.
func demoValue(net, mode string, r *rand.Rand) (float64, bool) {
	u := strings.ToUpper(net)
	if u == "" {
		return 0, true
	}
	if strings.Contains(u, "GND") {
		switch mode {
		case "res", "cont":
			return 0.2 + r.Float64()*0.1, false
		default:
			return 0.0, false
		}
	}
	nominal := 0.0
	if m := railRe.FindStringSubmatch(u); m != nil {
		a, _ := strconv.ParseFloat(m[1], 64)
		b := 0.0
		if m[2] != "" {
			b, _ = strconv.ParseFloat("0."+m[2], 64)
		}
		nominal = a + b
	} else if strings.Contains(u, "BUS") || strings.Contains(u, "DCIN") || strings.Contains(u, "VBUS") {
		nominal = 12.6
	}
	switch mode {
	case "dcv":
		if nominal == 0 {
			if strings.Contains(u, "_L") || strings.Contains(u, "EN") || strings.Contains(u, "PG") || strings.Contains(u, "RST") {
				return 3.3 * float64(r.Intn(2)), false
			}
			return r.Float64() * 0.02, false
		}
		if strings.Contains(u, "S5") || strings.Contains(u, "G3H") || strings.Contains(u, "BUS") || strings.Contains(u, "DCIN") {
			return nominal * (0.995 + r.Float64()*0.01), false
		}
		return 0.01 * r.Float64(), false // main rails off: board stuck in standby
	case "diode":
		if strings.Contains(u, "EC") && nominal > 0 {
			return 0.004 + r.Float64()*0.002, false // shorted rail for the demo
		}
		return 0.35 + float64(len(u)%7)*0.05 + r.Float64()*0.004, false
	case "res", "cont":
		if strings.Contains(u, "EC") && nominal > 0 {
			return 1.8 + r.Float64()*0.2, false
		}
		return 1000 * (2 + float64(len(u)%9)*7), false
	case "acv":
		return r.Float64() * 0.01, false
	}
	return 0, true
}

func (d *demoSim) meter(mode string) (float64, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	demoHint.Lock()
	net, at := demoHint.net, demoHint.at
	demoHint.Unlock()
	// Leads in the air for a moment after a new probe point, then the reading for that net.
	if net == "" || time.Since(at) < 1500*time.Millisecond {
		switch mode {
		case "dcv", "acv":
			return d.rng.Float64() * 0.003, false
		}
		return 9.9e37, true
	}
	return demoValue(net, mode, d.rng)
}

func (d *demoSim) psu() psuReading {
	d.mu.Lock()
	defer d.mu.Unlock()
	vs, is, on, cc := 20.0, 3.0, true, false
	t := time.Since(d.start).Seconds()
	amps := 0.018 + d.rng.Float64()*0.002 // standby draw: board stuck before the main rails start
	if math.Mod(t, 12) < 1.2 {
		amps = 0.09 + d.rng.Float64()*0.02 // periodic attempt to power on, then drop back
	}
	return psuReading{Volts: 19.98 + d.rng.Float64()*0.01, Amps: amps, VSet: &vs, ISet: &is, Output: &on, CC: &cc}
}

func (d *demoSim) scope(ch, item string) float64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := d.rng.Float64()
	if ch != "1" {
		switch item {
		case "vpp":
			return 0.04 + n*0.01
		case "vavg":
			return 1.8 + n*0.005
		case "vmax":
			return 1.82
		case "vmin":
			return 1.78
		}
		return 0
	}
	switch item {
	case "vpp":
		return 3.36 + n*0.04
	case "vmax":
		return 3.34 + n*0.02
	case "vmin":
		return -0.02 - n*0.02
	case "vavg":
		return 1.62 + n*0.02
	case "freq":
		return 32768 * (1 + (n-0.5)*0.0001)
	}
	return 0
}

// screen draws a scope-style screenshot of a 32.768 kHz RTC clock on CH1.
func (d *demoSim) screen() []byte {
	const W, H = 800, 480
	img := image.NewRGBA(image.Rect(0, 0, W, H))
	bg, grid, ch1, ch2, txt := color.RGBA{8, 10, 14, 255}, color.RGBA{48, 56, 64, 255}, color.RGBA{250, 220, 40, 255}, color.RGBA{60, 200, 240, 255}, color.RGBA{200, 200, 200, 255}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			img.Set(x, y, bg)
		}
	}
	for i := 0; i <= 10; i++ {
		for y := 20; y < H-40; y++ {
			img.Set(20+i*76, y, grid)
		}
	}
	for i := 0; i <= 8; i++ {
		for x := 20; x <= 780; x++ {
			img.Set(x, 20+i*52, grid)
		}
	}
	d.mu.Lock()
	ph := d.rng.Float64() * 40
	d.mu.Unlock()
	prevY := -1
	for x := 20; x <= 780; x++ {
		t := (float64(x-20) + ph) / 76.0 * 2 // two periods per division
		y := 228
		if math.Mod(t, 2) < 1 {
			y = 124
		}
		if prevY >= 0 && prevY != y {
			for yy := min(prevY, y); yy <= max(prevY, y); yy++ {
				img.Set(x, yy, ch1)
			}
		}
		img.Set(x, y, ch1)
		img.Set(x, y+1, ch1)
		prevY = y
		y2 := 330 + int(2*math.Sin(float64(x)/7))
		img.Set(x, y2, ch2)
	}
	for x := 30; x < 300; x++ { // caption bar
		for y := H - 30; y < H-12; y++ {
			if (x/6+y/6)%7 == 0 {
				img.Set(x, y, txt)
			}
		}
	}
	var out bytes.Buffer
	_ = png.Encode(&out, img)
	return out.Bytes()
}

// ---- manager ----

func newInstrument(c InstCfg) (*instrument, error) {
	p := instProfiles[c.Profile]
	if p == nil {
		return nil, fmt.Errorf("unknown instrument model %q", c.Profile)
	}
	c.Kind = p.Kind
	return &instrument{cfg: c, prof: p, st: instState{Status: "off"}}, nil
}

func benchGet(id string) *instrument {
	bench.Lock()
	defer bench.Unlock()
	return bench.m[id]
}

// benchFind picks an instrument by id, or the first connected one of a kind.
func benchFind(id, kind string) *instrument {
	if id != "" {
		return benchGet(id)
	}
	bench.Lock()
	defer bench.Unlock()
	var first *instrument
	for _, c := range cfg.Instruments {
		in := bench.m[c.ID]
		if in == nil || in.cfg.Kind != kind {
			continue
		}
		if in.state().Status == "connected" {
			return in
		}
		if first == nil {
			first = in
		}
	}
	return first
}

func initBench() {
	bench.Lock()
	for _, c := range cfg.Instruments {
		if in, err := newInstrument(c); err == nil {
			bench.m[c.ID] = in
		}
	}
	bench.Unlock()
	for _, c := range cfg.Instruments {
		if c.Auto {
			if in := benchGet(c.ID); in != nil {
				go in.connect()
			}
		}
	}
}

func shutdownBench() {
	bench.Lock()
	var all []*instrument
	for _, in := range bench.m {
		all = append(all, in)
	}
	bench.Unlock()
	for _, in := range all {
		in.close()
	}
}

type instView struct {
	InstCfg
	State   instState `json:"state"`
	Label   string    `json:"label"`
	Modes   []string  `json:"modes,omitempty"`
	Note    string    `json:"note,omitempty"`
	HasShot bool      `json:"has_shot,omitempty"`
}

func viewOf(in *instrument) instView {
	in.smu.Lock()
	hs := len(in.shot) > 0
	in.smu.Unlock()
	return instView{InstCfg: in.cfg, State: in.state(), Label: in.prof.Label, Modes: in.prof.Modes, Note: in.prof.Note, HasShot: hs}
}

func benchList() []instView {
	bench.Lock()
	defer bench.Unlock()
	var out []instView
	for _, c := range cfg.Instruments {
		if in := bench.m[c.ID]; in != nil {
			out = append(out, viewOf(in))
		}
	}
	return out
}

func saveInstCfg(c InstCfg) {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	for i := range cfg.Instruments {
		if cfg.Instruments[i].ID == c.ID {
			cfg.Instruments[i] = c
			_ = saveConfig()
			return
		}
	}
	cfg.Instruments = append(cfg.Instruments, c)
	_ = saveConfig()
}

var kindNames = map[string]string{"dmm": "Multimeter", "psu": "Power supply", "scope": "Oscilloscope"}

func readJSON(r *http.Request, v any) error {
	return json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

func registerInstrumentRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/instruments", func(w http.ResponseWriter, r *http.Request) {
		profs := map[string]*instProfile{}
		for k, p := range instProfiles {
			profs[k] = p
		}
		writeJSON(w, 200, map[string]any{"items": benchList(), "profiles": profs, "visa": visaAvailable(), "mode_labels": ModeLabel})
	})

	mux.HandleFunc("/api/instruments/ports", func(w http.ResponseWriter, r *http.Request) {
		v, err := listVISA()
		out := map[string]any{"serial": listSerialPorts(), "visa": v}
		if err != nil {
			out["visa_error"] = err.Error()
		}
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("/api/instruments/save", func(w http.ResponseWriter, r *http.Request) {
		var c InstCfg
		if r.Method != http.MethodPost || readJSON(r, &c) != nil {
			apiErr(w, 400, "Send the instrument settings as JSON.")
			return
		}
		p := instProfiles[c.Profile]
		if p == nil {
			apiErr(w, 400, "Choose the instrument's model.")
			return
		}
		okConn := false
		for _, x := range p.Conns {
			okConn = okConn || x == c.Conn
		}
		if !okConn {
			apiErr(w, 400, "That model doesn't connect that way.")
			return
		}
		c.Kind = p.Kind
		if strings.TrimSpace(c.Name) == "" {
			c.Name = kindNames[c.Kind]
		}
		newOne := c.ID == ""
		if newOne {
			c.ID = fmt.Sprintf("%s-%d", c.Kind, time.Now().UnixNano()%1e9)
			c.Show = true
		}
		bench.Lock()
		old := bench.m[c.ID]
		bench.Unlock()
		wasOn := old != nil && old.state().Status == "connected"
		if old != nil {
			if old.cfg.Conn == c.Conn && old.cfg.Addr == c.Addr && old.cfg.Baud == c.Baud && old.cfg.Profile == c.Profile && old.cfg.Channel == c.Channel && old.cfg.Channels == c.Channels {
				old.cfg.Name, old.cfg.Show = c.Name, c.Show // cosmetic change: keep the live connection
				saveInstCfg(old.cfg)
				writeJSON(w, 200, viewOf(old))
				return
			}
			old.close()
		}
		in, _ := newInstrument(c)
		bench.Lock()
		bench.m[c.ID] = in
		bench.Unlock()
		saveInstCfg(c)
		if wasOn || newOne {
			if err := in.connect(); err == nil {
				in.cfg.Auto = true
				saveInstCfg(in.cfg)
			}
		}
		writeJSON(w, 200, viewOf(in))
	})

	mux.HandleFunc("/api/instruments/delete", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		if in := benchGet(id); in != nil {
			in.close()
		}
		bench.Lock()
		delete(bench.m, id)
		bench.Unlock()
		cfgMu.Lock()
		var keep []InstCfg
		for _, c := range cfg.Instruments {
			if c.ID != id {
				keep = append(keep, c)
			}
		}
		cfg.Instruments = keep
		_ = saveConfig()
		cfgMu.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})

	mux.HandleFunc("/api/instruments/connect", func(w http.ResponseWriter, r *http.Request) {
		in := benchGet(r.URL.Query().Get("id"))
		if in == nil {
			apiErr(w, 404, "No such instrument.")
			return
		}
		if r.URL.Query().Get("off") == "1" {
			in.close()
			in.cfg.Auto = false
			saveInstCfg(in.cfg)
			writeJSON(w, 200, viewOf(in))
			return
		}
		if err := in.connect(); err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		in.cfg.Auto = true
		saveInstCfg(in.cfg)
		writeJSON(w, 200, viewOf(in))
	})

	mux.HandleFunc("/api/instruments/show", func(w http.ResponseWriter, r *http.Request) {
		in := benchGet(r.URL.Query().Get("id"))
		if in == nil {
			apiErr(w, 404, "No such instrument.")
			return
		}
		in.cfg.Show = r.URL.Query().Get("show") == "1"
		saveInstCfg(in.cfg)
		writeJSON(w, 200, viewOf(in))
	})

	mux.HandleFunc("/api/instruments/mode", func(w http.ResponseWriter, r *http.Request) {
		in := benchFind(r.URL.Query().Get("id"), "dmm")
		mode := r.URL.Query().Get("mode")
		if in == nil {
			apiErr(w, 404, "No multimeter is set up.")
			return
		}
		if modeUnit[mode] == "" {
			apiErr(w, 400, "Unknown meter function.")
			return
		}
		if err := in.setMeterMode(mode); err != nil {
			apiErr(w, 400, err.Error())
			return
		}
		_ = in.poll(true)
		writeJSON(w, 200, viewOf(in))
	})

	// measure takes a fresh reading now (used by the assistant). kind picks the first connected
	// instrument of that type when no id is given.
	mux.HandleFunc("/api/instruments/measure", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			ID, Kind, Mode string
			Channels       []string
			Items          []string
		}
		_ = readJSON(r, &q)
		in := benchFind(q.ID, q.Kind)
		if in == nil {
			apiErr(w, 404, "No "+strings.ToLower(kindNames[q.Kind])+" is set up. Add one from the bench bar.")
			return
		}
		if in.state().Status != "connected" {
			apiErr(w, 409, in.cfg.Name+" isn't connected.")
			return
		}
		if q.Mode != "" && in.cfg.Kind == "dmm" && q.Mode != in.mode {
			if err := in.setMeterMode(q.Mode); err != nil {
				apiErr(w, 400, err.Error())
				return
			}
			time.Sleep(400 * time.Millisecond)
		}
		if in.cfg.Kind == "scope" && (len(q.Channels) > 0 || len(q.Items) > 0) {
			chs, items := q.Channels, q.Items
			if len(chs) == 0 {
				chs = in.scopeChannels()
			}
			if len(items) == 0 {
				items = []string{"vpp", "vmax", "vmin", "vavg", "freq"}
			}
			in.io.Lock()
			m, err := in.scopeMeasure(chs, items)
			in.io.Unlock()
			if err != nil {
				apiErr(w, 502, err.Error())
				return
			}
			writeJSON(w, 200, map[string]any{"instrument": viewOf(in), "scope": &scopeReading{Channels: m, Text: scopeText(m)}})
			return
		}
		if err := in.poll(true); err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{"instrument": viewOf(in)})
	})

	mux.HandleFunc("/api/instruments/history", func(w http.ResponseWriter, r *http.Request) {
		in := benchFind(r.URL.Query().Get("id"), r.URL.Query().Get("kind"))
		if in == nil {
			apiErr(w, 404, "No such instrument.")
			return
		}
		secs, _ := strconv.Atoi(r.URL.Query().Get("seconds"))
		if secs <= 0 || secs > 600 {
			secs = 60
		}
		from := time.Now().Add(-time.Duration(secs) * time.Second).UnixMilli()
		in.smu.Lock()
		var out []sample
		for _, s := range in.hist {
			if s.T >= from {
				out = append(out, s)
			}
		}
		in.smu.Unlock()
		writeJSON(w, 200, map[string]any{"instrument": in.cfg.Name, "kind": in.cfg.Kind, "mode": in.mode, "samples": out})
	})

	mux.HandleFunc("/api/instruments/screenshot", func(w http.ResponseWriter, r *http.Request) {
		in := benchFind(r.URL.Query().Get("id"), "scope")
		if in == nil {
			apiErr(w, 404, "No oscilloscope is set up.")
			return
		}
		var data []byte
		var err error
		if r.Method == http.MethodPost {
			data, err = in.screenshot()
		} else {
			in.smu.Lock()
			data = in.shot
			in.smu.Unlock()
			if data == nil {
				err = errors.New("no screenshot yet")
			}
		}
		if err != nil {
			apiErr(w, 502, "Couldn't grab the scope screen: "+err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"png": base64.StdEncoding.EncodeToString(data)})
	})

	// Raw command console for setting up an unusual instrument.
	mux.HandleFunc("/api/instruments/command", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ ID, Cmd string }
		if r.Method != http.MethodPost || readJSON(r, &q) != nil || strings.TrimSpace(q.Cmd) == "" {
			apiErr(w, 400, "Enter a command.")
			return
		}
		in := benchGet(q.ID)
		if in == nil || in.prof.Proto == "demo" {
			apiErr(w, 404, "Connect a real instrument first.")
			return
		}
		in.io.Lock()
		defer in.io.Unlock()
		if !strings.Contains(q.Cmd, "?") && !strings.EqualFold(q.Cmd, "QM") && !strings.EqualFold(q.Cmd, "ID") {
			if err := in.write(q.Cmd); err != nil {
				apiErr(w, 502, err.Error())
				return
			}
			writeJSON(w, 200, map[string]string{"reply": "(sent)"})
			return
		}
		s, err := in.query(q.Cmd, 3*time.Second)
		if err != nil {
			apiErr(w, 502, err.Error())
			return
		}
		writeJSON(w, 200, map[string]string{"reply": s})
	})

	// The probe workflow tells the demo meter which net the leads are on.
	mux.HandleFunc("/api/instruments/hint", func(w http.ResponseWriter, r *http.Request) {
		demoHint.Lock()
		demoHint.net, demoHint.at = r.URL.Query().Get("net"), time.Now()
		demoHint.Unlock()
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
}
