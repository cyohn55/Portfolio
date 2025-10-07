"""
Centralized configuration for the Portfolio email-to-website system.
All paths and tweakable settings live here so that they can be
adjusted from a single place or overridden via environment variables
(ideal for CI / cloud execution).
"""

from __future__ import annotations

import os
from pathlib import Path

# -----------------------------------------------------------------------------
# Helper
# -----------------------------------------------------------------------------

def _env_path(name: str, default: Path) -> str:
    """Return environment variable `name` as a path string or the default."""
    return os.getenv(name, str(default))


# -----------------------------------------------------------------------------
# Base directories
# -----------------------------------------------------------------------------

# The repo root (one directory above CMS/) can be overridden for testing
BASE_DIR: Path = Path(os.getenv("PORTFOLIO_BASE_DIR", Path(__file__).resolve().parent.parent))

# Content directories
PAGES_DIR = _env_path("PAGES_DIR", BASE_DIR / "Pages")
IMAGES_DIR = _env_path("IMAGES_DIR", BASE_DIR / "images")
INDEX_PATH = _env_path("INDEX_PATH", BASE_DIR / "index.html")

# -----------------------------------------------------------------------------
# Defaults & limits
# -----------------------------------------------------------------------------
DEFAULT_IMAGE = os.getenv("DEFAULT_IMAGE", "images/python.jpg")
DEFAULT_DESCRIPTION_TEMPLATE = os.getenv(
    "DEFAULT_DESCRIPTION_TEMPLATE",
    "Learn about {title} in Cody's portfolio",
)

MAX_DESCRIPTION_LENGTH: int = int(os.getenv("MAX_DESCRIPTION_LENGTH", 120))
MAX_TITLE_PREFIX_LENGTH: int = int(os.getenv("MAX_TITLE_PREFIX_LENGTH", 20))

# -----------------------------------------------------------------------------
# Git identity (used for automated commits)
# -----------------------------------------------------------------------------
GIT_COMMIT_AUTHOR = os.getenv("GIT_COMMIT_AUTHOR", "Email-to-Portfolio System")
GIT_COMMIT_EMAIL = os.getenv("GIT_COMMIT_EMAIL", "system@portfolio.local")

# -----------------------------------------------------------------------------
# Supported media (extend here, code elsewhere will stay unchanged)
# -----------------------------------------------------------------------------
SUPPORTED_IMAGE_EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".svg",
]
SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".webm"]
SUPPORTED_AUDIO_EXTENSIONS = [".mp3", ".wav", ".ogg"] 