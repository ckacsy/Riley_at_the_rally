import io
import picamera
import socket
import struct
import time

HOST = '0.0.0.0'
PORT = 8000

def start_streaming():
    server_socket = socket.socket()
    server_socket.bind((HOST, PORT))
    server_socket.listen(0)
    print("Listening for connections...")
    connection = server_socket.accept()[0]
    print("Client connected!")
    connection.sendall(struct.pack('<L', 0))  # Send placeholder for client to request

    try:
        with picamera.PiCamera() as camera:
            camera.resolution = (640, 480)
            camera.framerate = 24
            time.sleep(2)  # Allow the camera to warm up

            stream = io.BytesIO()
            for frame in camera.capture_continuous(stream, 'jpeg', use_video_port=True):
                connection.sendall(struct.pack('<L', stream.tell()))  # Send the length of the frame
                connection.sendall(stream.getvalue())  # Send the frame data
                stream.seek(0)
                stream.truncate()  # Reset the stream for the next frame
    finally:
        connection.close()
        server_socket.close()

if __name__ == '__main__':
    start_streaming()