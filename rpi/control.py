#!/usr/bin/env python3
"""Raspberry Pi control script for RC car (L298N motor driver).

Receives drive commands from the backend server via Socket.io,
controls motors via L298N GPIO pins, and streams the camera as
an MJPEG feed served by Flask.

Usage:
    python control.py [--mock] [--server URL] [--stream-port PORT]

Options:
    --mock          Run without real GPIO/camera hardware (for testing)
    --server URL    Backend server URL (default: http://localhost:5000)
    --stream-port   Flask camera-stream port (default: 8000)
"""

import argparse
import io
import sys
import threading
import time

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser(description='RC Car Pi Controller')
parser.add_argument('--mock', action='store_true',
                    help='Run without real GPIO/camera hardware')
parser.add_argument('--server', default='http://localhost:5000',
                    help='Backend server URL')
parser.add_argument('--stream-port', type=int, default=8000,
                    help='Camera stream port (default: 8000)')
parser.add_argument('--car-id', type=int, default=None,
                    help='Car ID for device authentication (or set DEVICE_CAR_ID env var)')
parser.add_argument('--device-key', default=None,
                    help='Device key for authentication (or set DEVICE_KEY env var)')
args = parser.parse_args()

import os
MOCK = args.mock
SERVER_URL = args.server
STREAM_PORT = args.stream_port
CAR_ID      = args.car_id or int(os.environ.get('DEVICE_CAR_ID', '0') or '0') or None
DEVICE_KEY  = args.device_key or os.environ.get('DEVICE_KEY') or None

# ---------------------------------------------------------------------------
# L298N GPIO motor controller
# ---------------------------------------------------------------------------
# BCM pin assignments — adjust to match your wiring
# Motor A: throttle (forward/backward)
IN1 = 17
IN2 = 27
ENA = 18  # PWM-capable pin

# Motor B: steering (left/right)
IN3 = 22
IN4 = 23
ENB = 24  # PWM-capable pin

if not MOCK:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)


class MotorController:
    """Controls two L298N motor channels via GPIO PWM."""

    def __init__(self, mock=False):
        self.mock = mock
        self._speed = 0
        self._angle = 0
        if not mock:
            for pin in (IN1, IN2, ENA, IN3, IN4, ENB):
                GPIO.setup(pin, GPIO.OUT)
            self.pwm_throttle = GPIO.PWM(ENA, 100)
            self.pwm_steering = GPIO.PWM(ENB, 100)
            self.pwm_throttle.start(0)
            self.pwm_steering.start(0)

    def drive(self, speed, steering_angle):
        """Set throttle and steering.

        speed: -100..100  (positive = forward, negative = backward, 0 = stop)
        steering_angle: -30..30  (negative = left, positive = right)
        """
        self._speed = speed
        self._angle = steering_angle

        if self.mock:
            print(f'[MOCK] drive: speed={speed}, steering={steering_angle}')
            return

        # --- Throttle ---
        duty = min(abs(speed), 100)
        if speed > 0:
            GPIO.output(IN1, GPIO.HIGH)
            GPIO.output(IN2, GPIO.LOW)
        elif speed < 0:
            GPIO.output(IN1, GPIO.LOW)
            GPIO.output(IN2, GPIO.HIGH)
        else:
            GPIO.output(IN1, GPIO.LOW)
            GPIO.output(IN2, GPIO.LOW)
        self.pwm_throttle.ChangeDutyCycle(duty)

        # --- Steering ---
        # Map angle (-30..30) → duty cycle (0..100)
        steer_duty = min(int((abs(steering_angle) / 30) * 100), 100)
        if steering_angle < 0:
            GPIO.output(IN3, GPIO.HIGH)
            GPIO.output(IN4, GPIO.LOW)
        elif steering_angle > 0:
            GPIO.output(IN3, GPIO.LOW)
            GPIO.output(IN4, GPIO.HIGH)
        else:
            GPIO.output(IN3, GPIO.LOW)
            GPIO.output(IN4, GPIO.LOW)
        self.pwm_steering.ChangeDutyCycle(steer_duty)

    def stop(self):
        """Stop all motors."""
        self.drive(0, 0)
        if not self.mock:
            for pin in (IN1, IN2, IN3, IN4):
                GPIO.output(pin, GPIO.LOW)
            self.pwm_throttle.ChangeDutyCycle(0)
            self.pwm_steering.ChangeDutyCycle(0)

    def cleanup(self):
        """Release GPIO resources."""
        self.stop()
        if not self.mock:
            self.pwm_throttle.stop()
            self.pwm_steering.stop()
            GPIO.cleanup()


# ---------------------------------------------------------------------------
# Flask MJPEG camera stream
# ---------------------------------------------------------------------------

from flask import Flask, Response, jsonify

flask_app = Flask(__name__)


def _mock_frame():
    """Generate a simple grey JPEG frame with a timestamp overlay."""
    try:
        from PIL import Image, ImageDraw
        img = Image.new('RGB', (640, 480), color=(30, 30, 30))
        draw = ImageDraw.Draw(img)
        draw.text((180, 210), 'MOCK CAMERA FEED', fill=(200, 200, 200))
        draw.text((260, 260), time.strftime('%H:%M:%S'), fill=(180, 180, 180))
        buf = io.BytesIO()
        img.save(buf, format='JPEG')
        return buf.getvalue()
    except ImportError:
        # Minimal valid 1×1 grey JPEG (no Pillow required)
        return (
            b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01'
            b'\x00\x00\xff\xdb\x00C\x00\x08\x06\x06\x07\x06\x05\x08\x07\x07'
            b'\x07\t\t\x08\n\x0c\x14\r\x0c\x0b\x0b\x0c\x19\x12\x13\x0f\x14'
            b'\x1d\x1a\x1f\x1e\x1d\x1a\x1c\x1c $.\' ",#\x1c\x1c(7),01444'
            b'\x1f\'9=82<.342\x1eC\x11\t\t\x11"\x18\x1c\x14\x14\x1c"(.(((('
            b'((((((((((((((((((((((((((((((((((((((((((((((((((\xff\xc0\x00'
            b'\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00\xff\xc4\x00\x1f\x00'
            b'\x00\x01\x05\x01\x01\x01\x01\x01\x01\x00\x00\x00\x00\x00\x00'
            b'\x00\x00\x01\x02\x03\x04\x05\x06\x07\x08\t\n\x0b\xff\xda\x00'
            b'\x08\x01\x01\x00\x00?\x00\xfb\xd4P\x00\x00\x00\x00\x1f\xff\xd9'
        )


def generate_frames(mock=False):
    """Yield MJPEG frames from picamera or mock generator."""
    if mock:
        while True:
            frame = _mock_frame()
            yield (
                b'--frame\r\n'
                b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
            )
            time.sleep(1.0 / 24)
    else:
        import picamera
        with picamera.PiCamera() as camera:
            camera.resolution = (640, 480)
            camera.framerate = 24
            time.sleep(2)  # warm-up
            stream = io.BytesIO()
            for _ in camera.capture_continuous(stream, 'jpeg',
                                               use_video_port=True):
                stream.seek(0)
                frame = stream.read()
                yield (
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
                )
                stream.seek(0)
                stream.truncate()


@flask_app.route('/stream')
def video_stream():
    """MJPEG stream endpoint — point the <img> src to this URL."""
    return Response(
        generate_frames(mock=MOCK),
        mimetype='multipart/x-mixed-replace; boundary=frame'
    )


@flask_app.route('/health')
def health():
    """Simple health-check endpoint."""
    return jsonify({'status': 'ok', 'mock': MOCK})


def start_flask():
    # Werkzeug dev server is intentional here — this runs on an embedded Pi,
    # not in a multi-user production environment.
    flask_app.run(host='0.0.0.0', port=STREAM_PORT, threaded=True)


# ---------------------------------------------------------------------------
# Socket.io client — receives control_command from backend server
# ---------------------------------------------------------------------------

import socketio as sio_module

auth_payload = {}
if CAR_ID is not None and DEVICE_KEY:
    auth_payload = {'carId': CAR_ID, 'deviceKey': DEVICE_KEY}

sio = sio_module.Client()
motor = MotorController(mock=MOCK)

# Heartbeat: emit device:heartbeat every 15 seconds while connected.
_heartbeat_stop = threading.Event()


def _heartbeat_loop():
    """Emit device:heartbeat every 15 seconds while connected."""
    while not _heartbeat_stop.wait(15):
        if sio.connected and CAR_ID is not None:
            try:
                sio.emit('device:heartbeat', {
                    'carId': CAR_ID,
                    'timestamp': time.time(),
                })
            except Exception as exc:
                print(f'[heartbeat] emit error: {exc}')


@sio.on('device:heartbeat_ack')
def on_heartbeat_ack(data):
    pass  # acknowledgement received — no action needed


@sio.on('control_command')
def on_control_command(data):
    direction = data.get('direction')
    speed = data.get('speed', 0)
    steering_angle = data.get('steering_angle', 0)

    if direction == 'stop' or (speed == 0 and steering_angle == 0):
        motor.stop()
    else:
        motor.drive(speed, steering_angle)

    print(f'Command: direction={direction}, speed={speed}, '
          f'steering_angle={steering_angle}')


@sio.on('device:kicked')
def on_device_kicked(data):
    reason = data.get('reason', 'unknown') if data else 'unknown'
    print(f'Device kicked by server: {reason}')
    _heartbeat_stop.set()
    motor.stop()


@sio.on('connect')
def on_connect():
    print(f'Connected to backend server: {SERVER_URL}')
    _heartbeat_stop.clear()
    heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    heartbeat_thread.start()


@sio.on('disconnect')
def on_disconnect():
    print('Disconnected from backend server — stopping motors')
    _heartbeat_stop.set()
    motor.stop()


def connect_to_server():
    """Connect to backend with automatic reconnection on failure."""
    while True:
        try:
            sio.connect(SERVER_URL, auth=auth_payload)
            sio.wait()
        except Exception as exc:
            print(f'Connection error: {exc}. Retrying in 5 s…')
            time.sleep(5)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == '__main__':
    print(f'RC Car controller starting '
          f'(mock={MOCK}, server={SERVER_URL}, stream_port={STREAM_PORT}, '
          f'car_id={CAR_ID})')

    # Flask camera stream in background thread
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()
    print(f'Camera stream: http://<pi-ip>:{STREAM_PORT}/stream')

    # Socket.io connection in background thread
    sio_thread = threading.Thread(target=connect_to_server, daemon=True)
    sio_thread.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('Shutting down…')
        _heartbeat_stop.set()
        motor.cleanup()
