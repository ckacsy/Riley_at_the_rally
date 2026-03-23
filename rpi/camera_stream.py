import io
import time

from flask import Flask, Response, jsonify

_flask_app = Flask(__name__)
_MOCK = False


def _generate_frames():
    """Yield MJPEG-formatted frames from the Pi camera (or mock)."""
    if _MOCK:
        while True:
            try:
                from PIL import Image, ImageDraw
                img = Image.new('RGB', (640, 480), color=(30, 30, 30))
                draw = ImageDraw.Draw(img)
                draw.text((180, 210), 'MOCK CAMERA FEED', fill=(200, 200, 200))
                draw.text((260, 260), time.strftime('%H:%M:%S'), fill=(180, 180, 180))
                buf = io.BytesIO()
                img.save(buf, format='JPEG')
                frame = buf.getvalue()
            except ImportError:
                # Minimal valid 1×1 grey JPEG — no Pillow required
                frame = (
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
            time.sleep(2)  # camera warm-up
            stream = io.BytesIO()
            for _ in camera.capture_continuous(stream, 'jpeg', use_video_port=True):
                stream.seek(0)
                frame = stream.read()
                yield (
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
                )
                stream.seek(0)
                stream.truncate()


@_flask_app.route('/stream')
def video_stream():
    """MJPEG stream endpoint — point <img src="..."> to this URL."""
    return Response(
        _generate_frames(),
        mimetype='multipart/x-mixed-replace; boundary=frame',
    )


@_flask_app.route('/health')
def health():
    return jsonify({'status': 'ok', 'mock': _MOCK})


def start_streaming(port=8000, mock=False):
    """Start the Flask MJPEG camera stream server (blocks until stopped).

    Args:
        port: TCP port to listen on (default 8000).
        mock: When True, serve a generated test frame instead of real camera.
    """
    global _MOCK
    _MOCK = mock
    # Werkzeug dev server is intentional — this runs on an embedded Pi,
    # not in a multi-user production environment.
    _flask_app.run(host='0.0.0.0', port=port, threaded=True)


if __name__ == '__main__':
    start_streaming()