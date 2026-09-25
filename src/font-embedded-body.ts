// Embedded body-text font: Departure Mono 1.500 (OFL-1.1, Copyright 2022-2024
// Helena Zhang, https://departuremono.com / github.com/rektdeckard/departure-mono),
// subsetted to the body glyph set. Chosen as the --mono face: a true
// single-weight pixel monospace (one advance width, 350/550 upm) that sits at
// the same visual weight as the Doto chrome pin, closing the chrome/body gap
// that system mono had. No Reserved Font Name, so the subset keeps its name.
//
// Coverage: U+0020-007E + bullet/ellipsis/em-dash. Transcript content outside
// that (CJK, box drawing, most symbols) falls back through the --mono stack,
// same deal as the Doto chrome subset.
//
// Regenerate (fonttools + brotli in a venv):
//   curl -sL -o departure.woff2 \
//     "https://raw.githubusercontent.com/rektdeckard/departure-mono/main/public/assets/DepartureMono-1.500.woff2"
//   python -m fontTools.subset departure.woff2 \
//     --unicodes="U+0020-007E,U+2022,U+2026,U+2014" \
//     --flavor=woff2 --layout-features='' --hinting=False \
//     --output-file=departure-sub.woff2
//   # then base64 -i departure-sub.woff2 | tr -d '\n' becomes the URI below.
//
// OFL-1.1 requires the copyright notice travel with the font; full text:
// https://github.com/rektdeckard/departure-mono/blob/main/public/assets/LICENSE

export const BODY_FONT_FAMILY = "Departure Mono";

export const BODY_FONT_DATA_URI =
	"data:font/woff2;base64," +
	"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";
