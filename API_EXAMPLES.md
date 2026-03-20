# API Examples

## REST API Examples

### Get Car Status
**Request:**  
`GET /api/car/status`

**Response:**  
```json
{
  "status": "ok",
  "battery": "75%",
  "location": {"latitude": 42.36, "longitude": -71.05}
}
```

### Move Car
**Request:**  
`POST /api/car/move`

**Body:**  
```json
{
  "direction": "forward",
  "speed": "10"
}
```

**Response:**  
```json
{
  "status": "moving"
}
```

## WebSocket Events

### Connect to WebSocket
**Event:**  
`on connect`
  - Description: Triggers when a client connects to the WebSocket server.

### Control Car
**Event:**  
`control`

**Payload:**  
```json
{
  "action": "turn",
  "angle": "90"
}
```

### Car Status Update
**Event:**  
`carStatus`

**Payload:**  
```json
{
  "battery": "75%",
  "location": {"latitude": 42.36, "longitude": -71.05}
}
```

## Python Code Examples for Motor Controller

### Move Forward
```python
import requests

url = 'http://localhost:5000/api/car/move'
data = {'direction': 'forward', 'speed': '10'}

response = requests.post(url, json=data)
print(response.json())
```

### Turn
```python
import socket

ws = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
ws.connect(('localhost', 8765))
ws.sendall(b'control: {"action": "turn", "angle": "90"}')
ws.close()
```
