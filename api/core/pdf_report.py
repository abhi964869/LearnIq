"""Convert Markdown report content into a styled PDF (reportlab, serverless-safe)."""
from __future__ import annotations

import io
import re
import xml.sax.saxutils as sax

from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (ListFlowable, ListItem, Paragraph,
                                SimpleDocTemplate, Spacer)

BLUE = HexColor("#3E6AE1")
CARBON = HexColor("#171A20")
GRAPHITE = HexColor("#393C41")
PEWTER = HexColor("#5C5E62")

_STYLES = {
    "title": ParagraphStyle("t", fontName="Helvetica-Bold", fontSize=20, leading=26, textColor=CARBON, spaceAfter=4),
    "meta": ParagraphStyle("m", fontName="Helvetica", fontSize=9, leading=12, textColor=PEWTER, spaceAfter=16),
    "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=15, leading=20, textColor=CARBON, spaceBefore=14, spaceAfter=6),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=12.5, leading=17, textColor=CARBON, spaceBefore=12, spaceAfter=4),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=BLUE, spaceBefore=10, spaceAfter=3),
    "body": ParagraphStyle("b", fontName="Helvetica", fontSize=10.5, leading=15, textColor=GRAPHITE, spaceAfter=6),
    "bullet": ParagraphStyle("bl", fontName="Helvetica", fontSize=10.5, leading=15, textColor=GRAPHITE),
}


def _inline(text: str) -> str:
    """Escape XML, then re-apply bold/italic/code as reportlab markup."""
    text = sax.escape(text)
    text = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<!\*)\*(?!\*)(.+?)\*(?!\*)", r"<i>\1</i>", text)
    text = re.sub(r"`(.+?)`", r'<font face="Courier">\1</font>', text)
    return text


def markdown_to_pdf(title: str, markdown: str) -> bytes:
    """Render Markdown into a clean, branded PDF and return the bytes.

    Supports headings (#/##/###), bullet and numbered lists, bold/italic/code,
    blockquotes, and paragraphs. Unknown syntax renders as plain text.
    """
    from datetime import date

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm, title=title)
    story: list = [Paragraph(_inline(title or "LearnIQ Report"), _STYLES["title"]),
                   Paragraph(f"LearnIQ AI · {date.today().isoformat()}", _STYLES["meta"])]
    bullets: list[str] = []

    def flush() -> None:
        if bullets:
            story.append(ListFlowable(
                [ListItem(Paragraph(_inline(b), _STYLES["bullet"]), leftIndent=12) for b in bullets],
                bulletType="bullet", bulletColor=BLUE, leftIndent=10, spaceAfter=6))
            bullets.clear()

    for raw_line in (markdown or "").splitlines():
        line = raw_line.rstrip()
        if not line.strip():
            flush()
            continue
        if line.startswith("### "):
            flush(); story.append(Paragraph(_inline(line[4:]), _STYLES["h3"]))
        elif line.startswith("## "):
            flush(); story.append(Paragraph(_inline(line[3:]), _STYLES["h2"]))
        elif line.startswith("# "):
            flush(); story.append(Paragraph(_inline(line[2:]), _STYLES["h1"]))
        elif re.match(r"^\s*[-*+]\s+", line):
            bullets.append(re.sub(r"^\s*[-*+]\s+", "", line))
        elif re.match(r"^\s*\d+\.\s+", line):
            bullets.append(re.sub(r"^\s*\d+\.\s+", "", line))
        elif line.startswith("> "):
            flush(); story.append(Paragraph(_inline(line[2:]), _STYLES["body"]))
        else:
            flush(); story.append(Paragraph(_inline(line), _STYLES["body"]))
    flush()

    if len(story) <= 2:
        story.append(Paragraph("(No content)", _STYLES["body"]))
    doc.build(story)
    return buffer.getvalue()
