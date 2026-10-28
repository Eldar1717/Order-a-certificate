from flask import Flask, render_template, request, jsonify, redirect, url_for, session
from database import db
from database import Certificate  # Правильный импорт
from datetime import datetime
import logging
import os

import server_control

logging.basicConfig(
    level=os.environ.get('LOG_LEVEL', 'INFO').upper(),
    format='%(asctime)s %(levelname)s [%(name)s] %(message)s',
)
log = logging.getLogger('app')

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get(
    'DATABASE_URL', 'sqlite:///certificates.db'
)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'your-secret-key-here')

# Секретный ключ для доступа секретаря
SECRETARY_PASSWORD = os.environ.get('SECRETARY_PASSWORD', 'secret123')

# --------------------------------------------------------------------------- #
# Команда разработчиков для экрана ожидания (заставки киоска)
# --------------------------------------------------------------------------- #
# Медиа на карточке выбирается по приоритету:
#   video     — mp4/webm, крутится без звука в цикле (рекомендуется для киоска);
#   animation — гифка;
#   photo     — обычное фото (используется как постер и как запасной вариант).
# Файлы кладите в static/team/.
DEVELOPERS = [
    {
        'name': 'Эльдар',
        'role': 'Разработчик',
        'telegram': 'eldarik17',
        'photo': 'team/eldar.jpg',
        'animation': None,
        'video': None,
    },
    {
        'name': 'Азим',
        'role': 'Разработчик',
        'telegram': 'Azim_4',
        'photo': 'team/azim.jpg',
        'animation': None,
        'video': None,
    },
]

# Через сколько секунд простоя показывать заставку (0 — выключить)
IDLE_SCREEN_SECONDS = int(os.environ.get('IDLE_SCREEN_SECONDS', '45'))

if app.config['SECRET_KEY'] == 'your-secret-key-here':
    log.warning('SECRET_KEY не задан — задайте переменную окружения SECRET_KEY')
if SECRETARY_PASSWORD == 'secret123':
    log.warning('Используется пароль секретаря по умолчанию — задайте SECRETARY_PASSWORD')

db.init_app(app)

with app.app_context():
    try:
        db.create_all()
    except Exception as exc:  # noqa: BLE001 - приложение должно подняться и показать ошибку
        log.exception('Не удалось создать таблицы: %s', exc)

server_control.mark_started()
log.info('Приложение запущено, pid=%s, режим перезапуска=%s',
         os.getpid(), server_control.RESTART_MODE)


@app.context_processor
def inject_team():
    """Данные заставки доступны всем шаблонам, показываются только студентам."""
    return {
        'developers': DEVELOPERS,
        'idle_screen_seconds': IDLE_SCREEN_SECONDS,
    }


def is_secretary():
    """Проверяет, вошел ли пользователь как секретарь"""
    return session.get('role') == 'secretary'

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/order', methods=['GET', 'POST'])
def order_certificate():
    """Страница заказа справки для студентов (свободный доступ)"""
    if request.method == 'POST':
        student_name = request.form['student_name']
        student_group = request.form['student_group']
        birth_date = request.form['birth_date']
        request_place = request.form['request_place']
        quantity = int(request.form['quantity'])
        comment = request.form.get('comment', '')
        
        certificate = Certificate(
            student_name=student_name,
            student_group=student_group,
            birth_date=birth_date,
            request_place=request_place,
            quantity=quantity,
            comment=comment
        )
        
        db.session.add(certificate)
        db.session.commit()
        
        return redirect(url_for('order_success', certificate_id=certificate.id))
    
    return render_template('order_certificate.html')

@app.route('/order/success')
def order_success():
    """Страница успешного заказа"""
    certificate_id = request.args.get('certificate_id')
    return render_template('order_success.html', certificate_id=certificate_id)

@app.route('/student')
def student_dashboard():
    """Панель мониторинга для студентов (только просмотр)"""
    search = request.args.get('search', '')
    
    query = Certificate.query
    
    if search:
        query = query.filter(
            Certificate.student_name.ilike(f'%{search}%')
        )
    
    certificates = query.order_by(Certificate.created_at.desc()).all()
    
    # Преобразуем объекты в словари для шаблона
    certificates_data = []
    for cert in certificates:
        cert_data = cert.to_dict()
        # Добавляем оригинальные datetime объекты для шаблона
        cert_data['_obj'] = cert
        certificates_data.append(cert_data)
    
    return render_template('student_dashboard.html', 
                         certificates=certificates_data, 
                         search=search)

@app.route('/secretary/login', methods=['GET', 'POST'])
def secretary_login():
    """Вход для секретаря"""
    if is_secretary():
        return redirect(url_for('secretary_dashboard'))
    
    if request.method == 'POST':
        password = request.form['password']
        
        if password == SECRETARY_PASSWORD:
            session['role'] = 'secretary'
            return redirect(url_for('secretary_dashboard'))
        else:
            return render_template('secretary_login.html', error='Неверный пароль')
    
    return render_template('secretary_login.html')

@app.route('/secretary/logout')
def secretary_logout():
    """Выход секретаря"""
    session.pop('role', None)
    return redirect(url_for('index'))

@app.route('/secretary')
def secretary_dashboard():
    """Панель управления для секретаря"""
    if not is_secretary():
        return redirect(url_for('secretary_login'))
    
    return render_template('secretary_dashboard.html')

@app.route('/api/certificates')
def api_certificates():
    """API для получения списка справок"""
    search = request.args.get('search', '')
    status_filter = request.args.get('status', '')
    
    query = Certificate.query
    
    if search:
        query = query.filter(
            Certificate.student_name.ilike(f'%{search}%') |
            Certificate.request_place.ilike(f'%{search}%')
        )
    
    if status_filter:
        query = query.filter(Certificate.status == status_filter)
    
    certificates = query.order_by(Certificate.created_at.desc()).all()
    
    certificates_data = []
    for cert in certificates:
        cert_data = cert.to_dict()
        cert_data['can_edit'] = is_secretary()  # Разрешаем редактирование только секретарю
        certificates_data.append(cert_data)
    
    return jsonify(certificates_data)

@app.route('/api/certificates/<int:certificate_id>', methods=['PUT'])
def update_certificate(certificate_id):
    """API для обновления статуса справки"""
    if not is_secretary():
        return jsonify({'error': 'Доступ запрещен'}), 403
    
    certificate = Certificate.query.get_or_404(certificate_id)
    data = request.get_json()
    
    if 'status' in data:
        certificate.status = data['status']
        certificate.updated_at = datetime.utcnow()
    
    db.session.commit()
    
    cert_data = certificate.to_dict()
    cert_data['can_edit'] = True
    return jsonify(cert_data)

@app.route('/api/status')
def api_status():
    """API для получения статистики"""
    total = Certificate.query.count()
    in_work = Certificate.query.filter_by(status='в работе').count()
    ready = Certificate.query.filter_by(status='готово').count()
    rejected = Certificate.query.filter_by(status='отклонено').count()
    
    return jsonify({
        'total': total,
        'in_work': in_work,
        'ready': ready,
        'rejected': rejected
    })

@app.route('/check-status')
def check_status():
    """Страница проверки статуса по ID"""
    certificate_id = request.args.get('id')
    certificate = None
    
    if certificate_id:
        try:
            certificate = Certificate.query.get(int(certificate_id))
        except:
            certificate = None
    
    # Передаем словарь вместо объекта для избежания ошибок с датами
    certificate_data = certificate.to_dict() if certificate else None
    return render_template('check_status.html', certificate=certificate_data)

# --------------------------------------------------------------------------- #
# Диагностика и удалённое управление сервером
# --------------------------------------------------------------------------- #

def _check_database():
    """Лёгкая проверка БД: не тянет данные, только соединение."""
    try:
        from sqlalchemy import text
        db.session.execute(text('SELECT 1'))
        return True, None
    except Exception as exc:  # noqa: BLE001 - любую ошибку показываем в статусе
        db.session.rollback()
        return False, str(exc)[:300]


def _request_token():
    token = request.args.get('token')
    if not token:
        token = request.headers.get('X-Restart-Token')
    if not token:
        data = request.get_json(silent=True)
        if isinstance(data, dict):
            token = data.get('token')
    return token


@app.route('/healthz')
def healthz():
    """Health-check для watchdog-скрипта и панели секретаря."""
    db_ok, db_error = _check_database()
    payload = server_control.status_payload(db_ok, db_error)
    response = jsonify(payload)
    response.status_code = 200 if db_ok else 503
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/admin/status')
def api_admin_status():
    """Расширенный статус: доступен секретарю или по токену."""
    if not server_control.is_authorized(_request_token()):
        return jsonify({'error': 'Доступ запрещён'}), 403

    db_ok, db_error = _check_database()
    payload = server_control.status_payload(db_ok, db_error)
    payload['secretary_password_is_default'] = SECRETARY_PASSWORD == 'secret123'
    response = jsonify(payload)
    response.headers['Cache-Control'] = 'no-store'
    return response


@app.route('/api/admin/restart', methods=['POST'])
def api_admin_restart():
    """Запрос на перезапуск.

    Приложение отвечает на запрос и завершается через несколько секунд —
    поднять его заново должна служба Windows или watchdog-скрипт.
    """
    if not server_control.is_authorized(_request_token()):
        log.warning('Отклонён запрос перезапуска без прав доступа')
        return jsonify({'error': 'Доступ запрещён'}), 403

    data = request.get_json(silent=True)
    reason = ''
    if isinstance(data, dict):
        reason = data.get('reason') or ''
    reason = (reason or request.form.get('reason') or '')[:200]

    by = 'секретарь' if session.get('role') == 'secretary' else 'токен'
    ok, message = server_control.schedule_restart(reason or 'вручную', by)

    return jsonify({
        'ok': ok,
        'message': message,
        'restart_mode': server_control.RESTART_MODE,
        'exit_in_seconds': server_control.RESTART_DELAY,
        'reason': reason or 'вручную',
    }), (200 if ok else 409)


@app.route('/admin')
def admin_server():
    """Страница аварийного перезапуска по токену — открывается с телефона."""
    token = request.args.get('token', '')
    allowed = server_control.is_authorized(token)
    db_ok, db_error = _check_database()
    return render_template(
        'admin_server.html',
        allowed=allowed,
        token=token,
        token_enabled=server_control.token_enabled(),
        status=server_control.status_payload(db_ok, db_error),
    ), (200 if allowed else 403)


if __name__ == '__main__':
    app.run(
        debug=os.environ.get('FLASK_DEBUG') == '1',
        host='0.0.0.0',
        port=int(os.environ.get('PORT', '5000')),
    )