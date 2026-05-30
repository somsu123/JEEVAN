from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route('/api/bracelet/vitals', methods=['POST'])
def vitals():
    data = request.get_json()
    print(f"Received from bracelet: {data}")
    return jsonify({"status": "ok"}), 200

@app.route('/api/bracelet/heartbeat', methods=['POST'])
def heartbeat():
    data = request.get_json()
    print(f"Heartbeat: {data}")
    return jsonify({"status": "ok"}), 200

if __name__ == '__main__':
    print("=========================================================")
    print("TEST BACKEND RUNNING ON ALL INTERFACES (0.0.0.0) PORT 5050")
    print("=========================================================")
    app.run(host='0.0.0.0', port=5050, debug=True)
