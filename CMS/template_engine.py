"""Shared Jinja2 environment for the Portfolio CMS.

Any module can do:

    from template_engine import render
    html = render('page.html', title='Foo', ...)

Adding templates: drop *.html files inside CMS/templates/ .
"""

from __future__ import annotations

import functools
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, select_autoescape

TEMPLATE_DIR = Path(__file__).with_suffix("").parent / "templates"

@functools.cache
def _env() -> Environment:  # pragma: no cover
    """Return a cached Jinja2 Environment."""
    return Environment(
        loader=FileSystemLoader(str(TEMPLATE_DIR)),
        autoescape=select_autoescape(["html", "xml"]),
    )


def render(template_name: str, /, **context: Any) -> str:
    """Render *template_name* with *context* and return the resulting HTML."""
    return _env().get_template(template_name).render(**context) 