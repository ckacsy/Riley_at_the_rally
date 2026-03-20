import threading
import socketio
from rc_car_controller import RCCarController
from camera_stream import start_streaming

sio = socketio.Client()

car = RCCarController()

@sio.on('control_command')
def on_control_command(data):
    direction = data.get('direction')
    speed = data.get('speed', 50)
    steering_angle = data.get('steering_angle', 0)
    
    try:
        car.drive_command(speed, steering_angle)
        print(f"Executed: {direction} at {speed}% with {steering_angle}° steering")
    except Exception as e:
        print(f"Error executing command: {e}")

@sio.on('connect')
def on_connect():
    print('Connected to backend server')

@sio.on('disconnect')
def on_disconnect():
    print('Disconnected from backend server')
    car.stop()

def connect_to_server():
    server_url = 'http://localhost:5000'
    try:
        sio.connect(server_url)
        sio.wait()
    except Exception as e:
        print(f"Connection error: {e}")

if __name__ == '__main__':
    car_thread = threading.Thread(target=connect_to_server, daemon=True)
    car_thread.start()
    
    camera_thread = threading.Thread(target=start_streaming, daemon=True)
    camera_thread.start()
    
    try:
        while True:
            pass
    except KeyboardInterrupt:
        print("Shutting down...")
        car.stop()