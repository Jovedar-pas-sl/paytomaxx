"""Genera las fuentes de las apps (woff2) desde los originales de Google Fonts.

Las apps las cargan con next/font/local: el build no descarga nada de
fonts.googleapis.com (antes fallaba cuando Google no respondía).

Origen (licencia OFL, copiada al lado):
  https://github.com/google/fonts/raw/main/ofl/instrumentsans/InstrumentSans%5Bwdth,wght%5D.ttf
  https://github.com/google/fonts/raw/main/ofl/manrope/Manrope%5Bwght%5D.ttf

Uso (Python 3.10+, `pip install fonttools brotli`):
  python build_fonts.py "InstrumentSans[wdth,wght].ttf" instrument-sans.woff2 "wght=400:700;wdth=100" latin-ext
  python build_fonts.py "Manrope[wght].ttf" manrope.woff2 "wght=600:800" latin-ext

Pesos: texto 400-700 (variable); cifras y títulos Manrope 600-800 (variable,
30 KB: 800 en importes y títulos, 700 en las cifras de las tablas del panel,
para que haya jerarquía entre cifras; decisión D11 de la revisión visual). Rasgos: los de fontTools por defecto + tnum/pnum
(cifras tabulares), igual que Google.

Cobertura:
  latin-ext: latin + latin-ext de Google (todas las lenguas europeas con
             alfabeto latino). Para el texto y los títulos: nombres de
             clientes y chicas.
  ext-a:     latin + Latin Extended-A + ș/ț rumanas (para fuentes cuyo
             latin-ext completo pesa demasiado).
"""

import io
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# unicode-range de Google Fonts (css2) para los subsets latin y latin-ext.
LATIN = (
    "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, "
    "U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD"
)
LATIN_EXT = (
    "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, "
    "U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, "
    "U+2113, U+2C60-2C7F, U+A720-A7FF"
)
EXT_A = "U+0100-017F, U+0218-021B"

COVERAGE = {"latin-ext": LATIN_EXT, "ext-a": EXT_A}


def codepoints(ranges: str) -> set[int]:
    out: set[int] = set()
    for part in ranges.split(","):
        lo, _, hi = part.strip().removeprefix("U+").partition("-")
        out.update(range(int(lo, 16), int(hi or lo, 16) + 1))
    return out


def parse_limits(spec: str) -> dict[str, float | tuple[float, float]]:
    limits: dict[str, float | tuple[float, float]] = {}
    for item in spec.split(";"):
        tag, _, value = item.partition("=")
        lo, sep, hi = value.partition(":")
        limits[tag] = (float(lo), float(hi)) if sep else float(lo)
    return limits


def build(src: str, out: str, limit_spec: str, coverage: str) -> None:
    font = instancer.instantiateVariableFont(TTFont(src), parse_limits(limit_spec))
    # Recargar: el subsetter falla sobre la fuente recién instanciada en memoria.
    buf = io.BytesIO()
    font.save(buf)
    buf.seek(0)
    font = TTFont(buf)

    options = subset.Options()
    options.layout_features = [*options.layout_features, "tnum", "pnum"]
    options.notdef_outline = True
    options.flavor = "woff2"
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=codepoints(LATIN) | codepoints(COVERAGE[coverage]))
    subsetter.subset(font)
    font.flavor = "woff2"
    font.save(out)


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[4] not in COVERAGE:
        sys.exit(__doc__)
    build(*sys.argv[1:5])
