"""
Gmail SMTP sender — sends the generated email with resume attached.
Requires SMTP_APP_PASSWORD in settings.py (Gmail App Password).
"""
import logging
import smtplib
import sys
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))
import settings as cfg

log = logging.getLogger("email_sender")

_RESUME_DIR = Path(__file__).parent.parent.parent / "resume"


def _find_resume():
    for ext in ("*.pdf", "*.PDF"):
        files = list(_RESUME_DIR.glob(ext))
        if files:
            return files[0]
    return None


def send_email(to_email: str, subject: str, body: str) -> None:
    """Send email via Gmail SMTP with resume attached.

    Raises: ValueError for config errors, smtplib.SMTPException for send errors.
    """
    sender_email = getattr(cfg, "SENDER_EMAIL", "")
    app_password  = getattr(cfg, "SMTP_APP_PASSWORD", "")
    sender_name   = getattr(cfg, "SENDER_NAME", "Divesh Reddy Bonaspuram")

    if not sender_email:
        raise ValueError("SENDER_EMAIL not set in settings.py")
    if not app_password:
        raise ValueError(
            "SMTP_APP_PASSWORD not set in settings.py. "
            "Generate one at myaccount.google.com → Security → App Passwords."
        )

    msg = MIMEMultipart("mixed")
    msg["From"]    = f"{sender_name} <{sender_email}>"
    msg["To"]      = to_email
    msg["Subject"] = subject

    # Plain-text body
    msg.attach(MIMEText(body, "plain", "utf-8"))

    # Attach resume PDF
    resume_path = _find_resume()
    if resume_path:
        with open(resume_path, "rb") as f:
            pdf_part = MIMEApplication(f.read(), _subtype="pdf")
            pdf_part.add_header(
                "Content-Disposition", "attachment",
                filename=resume_path.name,
            )
            msg.attach(pdf_part)
        log.info("[sender] Attaching resume: %s", resume_path.name)
    else:
        log.warning("[sender] No resume PDF found in %s — sending without attachment", _RESUME_DIR)

    smtp_server = getattr(cfg, "SMTP_SERVER", "smtp.gmail.com")
    smtp_port   = getattr(cfg, "SMTP_PORT", 587)

    log.info("[sender] Connecting to %s:%d", smtp_server, smtp_port)
    with smtplib.SMTP(smtp_server, smtp_port, timeout=30) as server:
        server.ehlo()
        server.starttls()
        server.login(sender_email, app_password)
        server.sendmail(sender_email, to_email, msg.as_string())

    log.info("[sender] Sent to %s | subject=%r", to_email, subject)
