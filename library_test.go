package main

import "testing"

func TestMatchSchematics(t *testing.T) {
	files := []libFile{{Name: "ASUS X580VD rev 2.0 schematic.pdf"}, {Name: "X541UA.pdf"}, {Name: "820-00165-A.pdf"}, {Name: "820-01041.pdf"},
		{Name: "GA-H110M-S2H rev1.0.pdf"}, {Name: "GA-B250M-DS3H.pdf"}, {Name: "readme.pdf"}, {Name: "schematic.pdf", Dir: "Lenovo/NM-B061"}}
	for board, want := range map[string]string{"X580VD_REV2.0.fz": "ASUS X580VD rev 2.0 schematic.pdf", "820-00165.brd": "820-00165-A.pdf",
		"GA-H110M-S2H.cad": "GA-H110M-S2H rev1.0.pdf", "NM-B061 boardview.brd": "schematic.pdf"} {
		m := matchSchematics(board, files)
		if len(m) == 0 || m[0].Name != want {
			t.Errorf("%s: got %+v, want %s", board, m, want)
		}
	}
	if m := matchSchematics("unrelated_thing.brd", files); len(m) != 0 {
		t.Errorf("unexpected match %+v", m)
	}
}
