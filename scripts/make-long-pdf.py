"""Generate public/long.pdf: a 300-page, text-heavy test document (Letter size).

Every page has a heading and 40 lines of body text, so the text layer is
about as dense as a real protocol or report. Page numbers are printed large
in the top-right corner to make scroll positions easy to see.
"""
import random
import sys
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

pdfmetrics.registerFont(TTFont("Body", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"))

WORDS = ("participant visit screening dose adverse event sponsor site protocol "
         "investigator report form record schedule baseline follow-up laboratory "
         "sample consent review data entry query monitor audit trail signature "
         "version section table figure appendix criteria eligibility endpoint "
         "analysis safety efficacy randomization blinding deviation").split()

PAGES = int(sys.argv[2]) if len(sys.argv) > 2 else 300
out = sys.argv[1] if len(sys.argv) > 1 else "public"
rng = random.Random(42)

c = canvas.Canvas(f"{out}/long.pdf", pagesize=(612, 792), invariant=1, initialFontName="Body")
for n in range(1, PAGES + 1):
    c.setFont("Bold", 28)
    c.drawRightString(560, 740, str(n))
    c.setFont("Bold", 14)
    c.drawString(56, 740, f"Section {n}. Visit procedures")
    c.setFont("Body", 10)
    y = 712
    for _ in range(40):
        words = [rng.choice(WORDS) for _ in range(rng.randint(10, 13))]
        c.drawString(56, y, " ".join(words).capitalize() + ".")
        y -= 16
    c.showPage()
c.save()
print("ok", PAGES)
