from flask_sqlalchemy import SQLAlchemy
from datetime import datetime, timezone
import os

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    ZoneInfo = None

db = SQLAlchemy()

# Время в БД хранится в UTC, а показываем его в часовом поясе колледжа.
APP_TZ = os.environ.get('APP_TZ', 'Europe/Moscow')

try:
    LOCAL_TZ = ZoneInfo(APP_TZ) if ZoneInfo else None
except Exception:
    LOCAL_TZ = None


def fmt_dt(value):
    """UTC из базы → локальное время в формате ДД.ММ.ГГГГ ЧЧ:ММ."""
    if not value:
        return ''
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    if LOCAL_TZ:
        value = value.astimezone(LOCAL_TZ)
    return value.strftime('%d.%m.%Y %H:%M')

class Certificate(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    student_name = db.Column(db.String(100), nullable=False)
    student_group = db.Column(db.String(10), nullable=False)
    birth_date = db.Column(db.String(10), nullable=False)
    request_place = db.Column(db.String(200), nullable=False)
    quantity = db.Column(db.Integer, default=1)
    comment = db.Column(db.Text)
    status = db.Column(db.String(20), default='в работе')
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def to_dict(self):
        return {
            'id': self.id,
            'student_name': self.student_name,
            'student_group': self.student_group,
            'birth_date': self.birth_date,
            'request_place': self.request_place,
            'quantity': self.quantity,
            'comment': self.comment,
            'status': self.status,
            'created_at': fmt_dt(self.created_at),
            'updated_at': fmt_dt(self.updated_at)
        }
