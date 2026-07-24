"""Logging setup — structured, serverless-friendly (stdout)."""
import logging
import sys


def get_logger(name: str) -> logging.Logger:
    """Return a configured logger writing to stdout (captured by Vercel logs)."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s — %(message)s")
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger
