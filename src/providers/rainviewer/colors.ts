/**
 * RainViewer "Universal Blue" colour table (rain section): RGBA hex for each dBZ value,
 * starting at UNIVERSAL_BLUE_MIN_DBZ. Generated from RainViewer's published table
 * https://www.rainviewer.com/files/rainviewer_api_colors_table.csv (column "Universal Blue",
 * first 128 rows; the second 128 rows are the snow palette, not used because we request
 * tiles with snow=0).
 *
 * Checked on 2026-09-25: every non-transparent pixel of live rain tiles requested with
 * colour scheme 0 or 2 and options 0_0 matched this table exactly (scheme 0 and 2 returned
 * byte-identical tiles), so a pixel colour inverts to a dBZ value.
 * From 65 dBZ up the palette saturates: several dBZ share one colour, so the inverse is a range.
 */
export const UNIVERSAL_BLUE_MIN_DBZ = -10;
export const UNIVERSAL_BLUE_RGBA: readonly string[] = [
	"63615914", "66635a19", "69665c1e", "6c685d24", "6f6b5f29", "726e612e", "75706234", "78736439",
	"7c75653e", "7f786744", "827b6949", "857d6a4e", "88806c54", "8b826d59", "8e856f5e", "92887164",
	"9e93756e", "aa9e7978", "b6a97e82", "c2b4828c", "cec08796", "d2c48ba0", "d6c88faa", "dacc93b4",
	"ded097be", "88ddeeff", "6cd1ebff", "51c5e8ff", "36bae5ff", "1baee2ff", "00a3e0ff", "009ad5ff",
	"0091caff", "0088bfff", "007fb4ff", "0077aaff", "0070a3ff", "00699cff", "006295ff", "005b8eff",
	"005588ff", "005180ff", "004e78ff", "004a70ff", "004768ff", "ffee00ff", "ffe000ff", "ffd200ff",
	"ffc500ff", "ffb700ff", "ffaa00ff", "ff9f00ff", "ff9500ff", "ff8b00ff", "ff8100ff", "ff4400ff",
	"f23600ff", "e62800ff", "d91b00ff", "cd0d00ff", "c10000ff", "a80000ff", "8f0000ff", "760000ff",
	"5d0000ff", "ffaaffff", "ff9fffff", "ff95ffff", "ff8bffff", "ff81ffff", "ff77ffff", "ff6cffff",
	"ff62ffff", "ff58ffff", "ff4effff", "ffffffff", "ffffffff", "ffffffff", "ffffffff", "ffffffff",
	"ffffffff", "ffffffff", "ffffffff", "ffffffff", "ffffffff", "00ff00ff", "00ff00ff", "00ff00ff",
	"00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff",
	"00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff", "00ff00ff",
	"00ff00ff", "00ff00ff",
];
