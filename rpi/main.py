import argparse
import threading
import time

import socketio
from rc_car_controller import RCCarController
from camera_stream import start_streaming

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

parser = argparse.ArgumentParser(description='RC Car Pi Controller')
parser.add_argument('--server', default='http://localhost:5000',
                    help='Backend server URL (default: http://localhost:5000)')
parser.add_argument('--stream-port', type=int, default=8000,
                    help='Camera stream port (default: 8000)')
parser.add_argument('--mock', action='store_true',
                    help='Run without real GPIO/camera hardware (for testing)')
parser.add_argument('--car-id', type=int,
                    default=None,
                    help='Car ID for device authentication (or set DEVICE_CAR_ID env var)')
parser.add_argument('--device-key', default=None,
                    help='Device key for authentication (or set DEVICE_KEY env var)')
args = parser.parse_args()

import os
SERVER_URL  = args.server
STREAM_PORT = args.stream_port
MOCK        = args.mock
CAR_ID      = args.car_id or int(os.environ.get('DEVICE_CAR_ID', '0') or '0') or None
DEVICE_KEY  = args.device_key or os.environ.get('DEVICE_KEY') or None

# ---------------------------------------------------------------------------
# Socket.io + motor control
# ---------------------------------------------------------------------------

auth_payload = {}
if CAR_ID is not None and DEVICE_KEY:
    auth_payload = {'carId': CAR_ID, 'deviceKey': DEVICE_KEY}

sio = socketio.Client()
car = RCCarController() if not MOCK else None

# Heartbeat thread: emit device:heartbeat every 15 seconds after connection.
_heartbeat_stop = threading.Event()
_heartbeat_thread = None


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
    direction      = data.get('direction')
    speed          = data.get('speed', 0)
    steering_angle = data.get('steering_angle', 0)
    try:
        if car is None:
            print(f'[MOCK] direction={direction}, speed={speed}, steering={steering_angle}')
            return
        if direction == 'stop':
            car.stop()
        else:
            car.drive_command(speed, steering_angle)
        print(f'Executed: {direction} at {speed}% with {steering_angle}° steering')
    except Exception as e:
        print(f'Error executing command: {e}')


@sio.on('device:kicked')
def on_device_kicked(data):
    reason = data.get('reason', 'unknown') if data else 'unknown'
    print(f'Device kicked by server: {reason}')
    _heartbeat_stop.set()
    if car:
        car.stop()


@sio.on('connect')
def on_connect():
    global _heartbeat_thread
    print(f'Connected to backend server: {SERVER_URL}')
    # Stop any existing heartbeat thread before starting a new one.
    _heartbeat_stop.set()
    if _heartbeat_thread is not None:
        _heartbeat_thread.join(timeout=1)
    _heartbeat_stop.clear()
    _heartbeat_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    _heartbeat_thread.start()


@sio.on('disconnect')
def on_disconnect():
    print('Disconnected from backend server — stopping car')
    _heartbeat_stop.set()
    if car:
        car.stop()


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

    camera_thread = threading.Thread(
        target=start_streaming, kwargs={'port': STREAM_PORT, 'mock': MOCK}, daemon=True
    )
    camera_thread.start()
    print(f'Camera stream: http://<pi-ip>:{STREAM_PORT}/stream')

    sio_thread = threading.Thread(target=connect_to_server, daemon=True)
    sio_thread.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('Shutting down…')
        _heartbeat_stop.set()
        if car:
            car.stop()