
import speech_recognition as sr
import pyttsx3
import json
import os
import time
import threading
try:
    import keyboard
    HAS_KEYBOARD = True
except (ImportError, RuntimeError):
    HAS_KEYBOARD = False
import re
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, List, Dict

# Try optional imports
try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

try:
    import xml.etree.ElementTree as ET
    HAS_XML = True
except ImportError:
    HAS_XML = False



def discover_ollama_model():
    """Dynamically discover the best installed Ollama model, preferring llama3.2."""
    # 1. Check environment variable override
    if "OLLAMA_MODEL" in os.environ:
        return os.environ["OLLAMA_MODEL"]
    
    # 2. Check installed models dynamically
    try:
        import ollama
        res = ollama.list()
        installed = []
        if hasattr(res, "models"):
            installed = [m.model for m in res.models if hasattr(m, "model")]
        elif isinstance(res, dict) and "models" in res:
            installed = [m.get("model") for m in res["models"] if isinstance(m, dict)]
        else:
            installed = [getattr(m, "model", "") or m.get("model", "") for m in res]
        
        # Clean list
        installed = [m for m in installed if m]
        
        # Priority list of models we prefer
        preferred = ["llama3.2:latest", "llama3.2", "llama3:latest", "llama3", "phi3:latest", "gemma2:latest", "gemma:latest", "mistral:latest"]
        for p in preferred:
            if p in installed:
                return p
        
        # If any preferred model is a partial match
        for p in preferred:
            p_base = p.split(":")[0]
            for inst in installed:
                if inst.startswith(p_base):
                    return inst
                    
        # If we have any installed model, use it
        if installed:
            return installed[0]
    except Exception as e:
        print(f"[WARN]: Dynamic model discovery failed: {e}")
        
    return "llama3.2:latest"  # Ultimate fallback

OLLAMA_MODEL = discover_ollama_model()
WEATHER_CITY = "Kolkata"
SLEEP_TIMEOUT_SECONDS = 30
WAKE_KEY = "g"
LOG_FILE = "daily_log.json"
MEDICINES_FILE = "medicines.json"
CHAT_HISTORY_FILE = "chat_history.json"
REMINDER_ADVANCE_MINUTES = 5
MAX_CHAT_HISTORY = 20


DAILY_ROUTINES = {
    (12, 0): "Have you bathed today?",
    (13, 30): "Have you had lunch?",
}


# ══════════════════════════════════════════════════
# 3. HEALTH KNOWLEDGE BASE
# ══════════════════════════════════════════════════
HEALTH_ADVICE = {
    "headache": {
        "keywords": ["headache", "head pain", "head ache", "head is paining", "head hurts",
                      "migraine", "head throbbing"],
        "advice": (
            "For a headache, here is what you should do. "
            "First, take rest in a dark and quiet room. "
            "Drink plenty of water as dehydration can cause headaches. "
            "You can gently massage your temples and forehead. "
            "Apply a cold or warm compress on your forehead."
        ),
        "medicines": ["Saridon", "Paracetamol (Crocin)", "Disprin"],
        "warning": "If the headache is severe or lasts more than 2 days, please consult a doctor immediately."
    },
    "gastric": {
        "keywords": ["gastric", "acidity", "acid reflux", "gas problem", "heartburn",
                      "stomach burning", "indigestion", "gas trouble"],
        "advice": (
            "For gastric or acidity problems, avoid spicy, oily, and fried food. "
            "Drink warm water or jeera water. "
            "Eat smaller meals more frequently instead of large meals. "
            "Avoid lying down immediately after eating. "
            "Chew food slowly and thoroughly."
        ),
        "medicines": ["ENO powder", "Gelusil", "Digene", "Gas-O-Fast", "Pantoprazole"],
        "warning": "If acidity persists for more than a week, please see a doctor."
    },
    "bloating": {
        "keywords": ["bloating", "bloated", "stomach full", "stomach swollen",
                      "belly bloat", "feeling heavy stomach"],
        "advice": (
            "For bloating, try these remedies. "
            "Drink warm water with a pinch of ajwain or jeera seeds. "
            "Walk slowly for 10 to 15 minutes after meals. "
            "Avoid carbonated drinks, beans, and cabbage. "
            "Eat slowly and do not talk while eating. "
            "Ginger tea or peppermint tea can provide quick relief."
        ),
        "medicines": ["Pudin Hara", "Hajmola", "Gas-O-Fast", "Cyclopam"],
        "warning": "If bloating is accompanied by severe pain, please visit a doctor."
    },
    "vomiting": {
        "keywords": ["vomiting", "vomit", "throwing up", "nausea", "feeling sick",
                      "want to vomit", "puking", "ulti"],
        "advice": (
            "For vomiting and nausea, do the following. "
            "Sip small amounts of clear fluids like water or coconut water. "
            "Do not eat solid food until vomiting stops. "
            "Suck on ice chips or frozen fruit bars. "
            "Rest in a sitting or propped up position, not lying flat. "
            "Once better, start with bland foods like rice, toast, or banana."
        ),
        "medicines": ["Domstal (Domperidone)", "Ondem (Ondansetron)", "Electral powder (for rehydration)", "ORS"],
        "warning": "If vomiting continues for more than 24 hours or you see blood, go to the hospital immediately."
    },
    "asthma": {
        "keywords": ["asthma", "breathing problem", "breathless", "wheezing",
                      "difficulty breathing", "shortness of breath", "chest tight",
                      "cant breathe", "suffocating"],
        "advice": (
            "For asthma or breathing difficulty, please do the following immediately. "
            "Sit upright, do not lie down. "
            "Stay calm and take slow, deep breaths. "
            "Use your rescue inhaler if you have one, take 2 puffs. "
            "Move away from any dust, smoke, or strong smells. "
            "Drink warm water slowly. "
            "If you have a nebulizer at home, use it now."
        ),
        "medicines": ["Asthalin inhaler (Salbutamol)", "Deriphyllin", "Budecort inhaler", "Montelukast"],
        "warning": "If breathing does not improve in 15 minutes, call emergency services or go to the nearest hospital immediately. This can be life threatening."
    },
    "stress": {
        "keywords": ["stress", "stressed", "tension", "anxious", "anxiety", "worried",
                      "nervous", "panic", "overwhelmed", "restless", "mental pressure",
                      "depressed", "sad", "feeling low", "upset"],
        "advice": (
            "I understand you are feeling stressed, and that is completely okay. "
            "Here are some things that can help you feel better. "
            "First, try the 4-7-8 breathing technique: breathe in for 4 seconds, "
            "hold for 7 seconds, and breathe out slowly for 8 seconds. Repeat 3 times. "
            "Go for a short, gentle walk outside if possible. Fresh air helps a lot. "
            "Listen to your favorite calm music or devotional songs. "
            "Talk to a family member or friend about how you are feeling. "
            "Drink a warm cup of tea, chamomile tea is especially calming. "
            "Avoid watching too much news or scrolling the phone. "
            "Try to do something you enjoy, like gardening, reading, or prayer. "
            "Remember, it is okay to rest. You do not always have to be busy."
        ),
        "medicines": ["Ashwagandha tablets (herbal, for general calm)", "Brahmi (herbal supplement)"],
        "warning": "If you feel very low or hopeless for more than 2 weeks, please talk to a doctor. There is no shame in seeking help."
    },
    "fever": {
        "keywords": ["fever", "high temperature", "feeling hot", "body hot",
                      "chills", "shivering", "bukhar"],
        "advice": (
            "For fever, rest in bed and drink plenty of fluids. "
            "Use a damp cloth on your forehead to cool down. "
            "Wear light, comfortable clothing. "
            "Eat light food like soup, khichdi, or dal rice. "
            "Check your temperature every 2 hours if possible."
        ),
        "medicines": ["Paracetamol (Crocin/Dolo 650)", "Meftal-Spas (if body pain with fever)"],
        "warning": "If fever is above 103 degrees Fahrenheit or lasts more than 3 days, please consult a doctor."
    },
    "cold": {
        "keywords": ["cold", "cough", "runny nose", "sneezing", "sore throat",
                      "blocked nose", "stuffy nose", "throat pain", "coughing"],
        "advice": (
            "For cold and cough, drink warm water with honey and ginger. "
            "Gargle with warm salt water for sore throat. "
            "Take steam inhalation 2 to 3 times a day. "
            "Keep yourself warm and rest well. "
            "Drink turmeric milk before bed. "
            "Avoid cold water and ice cream."
        ),
        "medicines": ["Vicks VapoRub (for chest application)", "Benadryl cough syrup",
                       "Cetrizine (for sneezing)", "Strepsils (for sore throat)"],
        "warning": "If cough has blood or persists beyond 2 weeks, see a doctor."
    },
    "diarrhea": {
        "keywords": ["diarrhea", "loose motion", "loose stool", "watery stool",
                      "stomach running", "frequent toilet"],
        "advice": (
            "For diarrhea, the most important thing is to stay hydrated. "
            "Drink ORS solution or Electral powder mixed in water immediately. "
            "Eat bland foods like rice, curd rice, banana, and toast. "
            "Avoid milk, spicy food, and oily food. "
            "Wash hands frequently to prevent spreading."
        ),
        "medicines": ["Electral powder (ORS)", "Loperamide (Imodium)", "Racecadotril", "Norfloxacin (if infection, doctor prescribed)"],
        "warning": "If diarrhea lasts more than 2 days or you feel very weak, please see a doctor to prevent dehydration."
    },
    "body_pain": {
        "keywords": ["body pain", "body ache", "muscle pain", "back pain", "joint pain",
                      "knee pain", "leg pain", "shoulder pain", "neck pain", "pain in body"],
        "advice": (
            "For body pain, rest the affected area. "
            "Apply a hot water bag or warm compress for 15 to 20 minutes. "
            "Gentle stretching can help if the pain is muscular. "
            "Massage the area gently with pain relief oil or balm. "
            "Maintain good posture while sitting and sleeping."
        ),
        "medicines": ["Combiflam (Ibuprofen + Paracetamol)", "Moov spray or cream",
                       "Volini spray", "Ibuprofen"],
        "warning": "If pain is severe, sudden, or in the chest area, seek immediate medical help."
    },
    "dehydration": {
        "keywords": ["dehydration", "dehydrated", "very thirsty", "dry mouth",
                      "dark urine", "not drinking water", "feeling weak and thirsty"],
        "advice": (
            "For dehydration, immediately drink ORS solution or Electral powder mixed in one liter of water. "
            "Sip slowly and continuously, do not gulp large amounts at once. "
            "Coconut water, buttermilk, and lemon water are also very helpful. "
            "Rest in a cool place, avoid sun exposure. "
            "Eat fruits with high water content like watermelon and cucumber."
        ),
        "medicines": ["Electral powder", "ORS sachets", "Coconut water"],
        "warning": "If you feel dizzy, confused, or cannot keep fluids down, go to the hospital immediately."
    },
    "dizziness": {
        "keywords": ["dizzy", "dizziness", "lightheaded", "room spinning", "vertigo",
                      "feeling faint", "head spinning", "chakkar"],
        "advice": (
            "For dizziness, immediately sit or lie down to prevent falling. "
            "Drink water or juice slowly. "
            "If you have low blood pressure, eat something salty. "
            "Avoid sudden movements, especially standing up quickly. "
            "Take deep, slow breaths. "
            "If you have been in the sun, move to a cool place."
        ),
        "medicines": ["Vertin (Betahistine, for vertigo)", "ORS (if dehydration related)"],
        "warning": "Frequent dizziness can indicate a serious condition. Please consult a doctor if it happens often."
    },
    "insomnia": {
        "keywords": ["insomnia", "cannot sleep", "cant sleep", "not sleeping",
                      "sleepless", "trouble sleeping", "awake at night", "sleep problem"],
        "advice": (
            "For sleep problems, try these tips. "
            "Avoid tea, coffee, and screen time at least 1 hour before bed. "
            "Drink warm milk with a pinch of turmeric before sleeping. "
            "Keep your room dark, cool, and quiet. "
            "Try the 4-7-8 breathing technique to relax. "
            "Maintain a fixed sleep schedule, go to bed at the same time every night. "
            "Light stretching or gentle yoga before bed can help."
        ),
        "medicines": ["Melatonin (herbal sleep aid)", "Ashwagandha (for relaxation)"],
        "warning": "If sleep problems persist beyond 2 weeks, please consult a doctor. Do not take sleeping pills without prescription."
    },
    "blood_pressure_high": {
        "keywords": ["high blood pressure", "bp high", "high bp", "hypertension",
                      "blood pressure up"],
        "advice": (
            "For high blood pressure, please sit down and rest immediately. "
            "Take slow, deep breaths for 5 minutes. "
            "Drink water. Avoid salt, fried food, and stress. "
            "If you have prescribed BP medicine, take it as scheduled. "
            "Walk gently for 15 minutes daily to manage long term BP."
        ),
        "medicines": ["Telmisartan (if prescribed)", "Amlodipine (if prescribed)"],
        "warning": "High blood pressure is serious. Always take your prescribed medicines on time. If BP is very high with headache or chest pain, go to the hospital."
    },
    "blood_pressure_low": {
        "keywords": ["low blood pressure", "bp low", "low bp", "hypotension",
                      "blood pressure down", "bp dropping"],
        "advice": (
            "For low blood pressure, lie down immediately with legs slightly elevated. "
            "Drink salted water or lemon water with salt. "
            "Eat something salty like salted biscuits. "
            "Avoid standing for long periods. "
            "Stay hydrated throughout the day."
        ),
        "medicines": ["ORS", "Salted water or lemon juice"],
        "warning": "If you feel faint or your vision goes dark, seek immediate medical help."
    },
}


# ══════════════════════════════════════════════════
# 4. JOKES DATABASE
# ══════════════════════════════════════════════════
JOKES = [
    "Why did the doctor carry a red pen? In case they needed to draw blood!",
    "What do you call a fish without eyes? A fsh!",
    "Why don't scientists trust atoms? Because they make up everything!",
    "What did the ocean say to the beach? Nothing, it just waved!",
    "Why did the scarecrow win an award? Because he was outstanding in his field!",
    "What do you call a bear with no teeth? A gummy bear!",
    "Why did the bicycle fall over? Because it was two tired!",
    "What do you call a sleeping dinosaur? A dino-snore!",
    "Why can't you give Elsa a balloon? Because she will let it go!",
    "What do you call cheese that isn't yours? Nacho cheese!",
    "Why did the tomato turn red? Because it saw the salad dressing!",
    "What do you call a lazy kangaroo? A pouch potato!",
    "Why did the math book look so sad? Because it had too many problems!",
    "What do you call a dog that does magic tricks? A Labra-cadabra-dor!",
    "Why do bees have sticky hair? Because they use honeycombs!",
    "What did one wall say to the other wall? I will meet you at the corner!",
    "Why did the golfer bring two pairs of pants? In case he got a hole in one!",
    "What do you call a fake noodle? An impasta!",
    "Why can't a nose be 12 inches long? Because then it would be a foot!",
    "What do you call a cow with no legs? Ground beef!",
    "Why did the cookie go to the hospital? Because it felt crummy!",
    "What kind of shoes do ninjas wear? Sneakers!",
    "Why did the student eat his homework? Because his teacher told him it was a piece of cake!",
    "What do you call a snowman with a six pack? An abdominal snowman!",
    "Why did the chicken join a band? Because it had the drumsticks!",
    "What do you call a train that sneezes? Achoo-choo train!",
    "Why do cows wear bells? Because their horns don't work!",
    "What do you get when you cross a snowman with a vampire? Frostbite!",
    "Why did the banana go to the doctor? Because it was not peeling well!",
    "What did the big flower say to the little flower? Hey there, little bud!",
    "Why did the man put his money in the freezer? He wanted cold hard cash!",
    "What do you call a pig that does karate? A pork chop!",
    "Why did the stadium get hot? Because all the fans left!",
    "What animal is always at a baseball game? A bat!",
    "Why did the traffic light turn red? It had to change in front of all those people!",
]


# ══════════════════════════════════════════════════
# 5. DEFAULT MEDICINES
# ══════════════════════════════════════════════════
DEFAULT_MEDICINES = [
    {
        "name": "Paracetamol",
        "purpose": "Used for treating fever and pain relief",
        "timing": "08:00",
        "box_number": 1,
        "added_date": "default"
    },
    {
        "name": "Metformin",
        "purpose": "Used for blood sugar control",
        "timing": "14:00",
        "box_number": 2,
        "added_date": "default"
    },
    {
        "name": "Telmisartan",
        "purpose": "Used for controlling high blood pressure",
        "timing": "20:00",
        "box_number": 3,
        "added_date": "default"
    },
]


# ══════════════════════════════════════════════════
# 6. CHAT MEMORY — Persistent Conversation History
# ══════════════════════════════════════════════════
class ChatMemory:
    """Stores conversation history for context-aware Ollama responses."""

    def __init__(self, filepath=CHAT_HISTORY_FILE, max_messages=MAX_CHAT_HISTORY):
        self.filepath = filepath
        self.max_messages = max_messages
        self._lock = threading.Lock()
        self.messages = self._load()

    def _load(self):
        """Load chat history from file."""
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    return data[-self.max_messages:]  # Keep only recent messages
            except (json.JSONDecodeError, FileNotFoundError):
                return []
        return []

    def _save(self):
        """Save chat history to file."""
        with open(self.filepath, "w", encoding="utf-8") as f:
            json.dump(self.messages, f, indent=2, ensure_ascii=False)

    def add(self, role, content):
        """Add a message to chat history."""
        with self._lock:
            self.messages.append({
                "role": role,
                "content": content,
                "timestamp": datetime.now().isoformat()
            })
            # Trim to max size
            if len(self.messages) > self.max_messages:
                self.messages = self.messages[-self.max_messages:]
            self._save()

    def get_ollama_messages(self):
        """Return messages formatted for Ollama context (last 10 for speed)."""
        recent = self.messages[-10:]
        return [{"role": m["role"], "content": m["content"]} for m in recent]

    def get_summary(self):
        """Return a brief summary of recent chat topics for context."""
        if not self.messages:
            return "No previous conversations."
        recent = self.messages[-5:]
        lines = []
        for m in recent:
            role = "User" if m["role"] == "user" else "Assistant"
            content = m["content"][:100]
            lines.append(f"{role}: {content}")
        return "\n".join(lines)


# ══════════════════════════════════════════════════
# 7. MEDICINE MANAGER — Dynamic CRUD
# ══════════════════════════════════════════════════
class MedicineManager:
    """Manages medicines.json for dynamic add/delete/list operations."""

    def __init__(self, filepath=MEDICINES_FILE):
        self.filepath = filepath
        self._lock = threading.Lock()
        self.medicines = self._load()

    def _load(self):
        """Load medicines from file, initialize with defaults if not exists."""
        if os.path.exists(self.filepath):
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    return json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                pass
        # Initialize with defaults
        self._save_data(DEFAULT_MEDICINES)
        return list(DEFAULT_MEDICINES)

    def _save(self):
        """Save current medicines to file."""
        self._save_data(self.medicines)

    def _save_data(self, data):
        """Write data to the medicines file."""
        with open(self.filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def get_all(self):
        """Return all medicines."""
        with self._lock:
            return list(self.medicines)

    def add(self, name, purpose, timing, box_number=None):
        """Add a new medicine."""
        with self._lock:
            # Auto-assign box number if not provided
            if box_number is None:
                existing_boxes = [m.get("box_number", 0) for m in self.medicines]
                box_number = max(existing_boxes + [0]) + 1

            medicine = {
                "name": name,
                "purpose": purpose,
                "timing": timing,
                "box_number": box_number,
                "added_date": datetime.now().strftime("%Y-%m-%d")
            }
            self.medicines.append(medicine)
            self._save()
            return medicine

    def delete(self, name):
        """Delete a medicine by name (case-insensitive). Returns True if deleted."""
        with self._lock:
            name_lower = name.lower().strip()
            original_len = len(self.medicines)
            self.medicines = [
                m for m in self.medicines
                if m["name"].lower().strip() != name_lower
            ]
            if len(self.medicines) < original_len:
                self._save()
                return True
            return False

    def find(self, name):
        """Find a medicine by name (case-insensitive, partial match)."""
        name_lower = name.lower().strip()
        for med in self.medicines:
            if name_lower in med["name"].lower():
                return med
        return None

    def get_by_box(self, box_number):
        """Get medicine by box number."""
        for med in self.medicines:
            if med.get("box_number") == box_number:
                return med
        return None

    def get_schedule(self):
        """Return a dict of {(hour, minute): medicine_dict} for reminders."""
        schedule = {}
        for med in self.medicines:
            timing = med.get("timing", "")
            if timing:
                try:
                    parts = timing.split(":")
                    hour = int(parts[0])
                    minute = int(parts[1]) if len(parts) > 1 else 0
                    schedule[(hour, minute)] = med
                except (ValueError, IndexError):
                    pass
        return schedule


# ══════════════════════════════════════════════════
# 8. TTS ENGINE — Fixed for Windows Threading
# ══════════════════════════════════════════════════
class VoiceEngine:
    """Thread-safe text-to-speech wrapper using pyttsx3."""

    def __init__(self):
        self._lock = threading.Lock()
        # Test initialization
        engine = pyttsx3.init()
        engine.stop()
        del engine
        print("[INIT]: pyttsx3 TTS engine OK.")

    def _create_engine(self):
        """Create a fresh pyttsx3 engine (workaround for Windows threading bug)."""
        engine = pyttsx3.init()
        engine.setProperty("rate", 140)  # Elderly-friendly pace
        engine.setProperty("volume", 1.0)
        voices = engine.getProperty("voices")
        if len(voices) > 1:
            engine.setProperty("voice", voices[1].id)
        return engine

    def speak(self, text):
        """Speak the given text aloud."""
        print(f"[ASSISTANT]: {text}")
        with self._lock:
            try:
                engine = self._create_engine()
                engine.say(text)
                engine.runAndWait()
                engine.stop()
                del engine
            except Exception as e:
                print(f"[ERROR]: TTS failed — {e}")


# ══════════════════════════════════════════════════
# 9. SPEECH RECOGNITION
# ══════════════════════════════════════════════════
class VoiceListener:
    """Microphone listener using SpeechRecognition."""

    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.recognizer.energy_threshold = 300
        self.recognizer.dynamic_energy_threshold = True
        self.recognizer.pause_threshold = 1.5

    def listen(self, timeout=SLEEP_TIMEOUT_SECONDS):
        # type: (...) -> Optional[str]
        """Listen for speech. Returns text, empty string if not understood, or None if timeout."""
        with sr.Microphone() as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=0.5)
            try:
                audio = self.recognizer.listen(source, timeout=timeout, phrase_time_limit=15)
                text = self.recognizer.recognize_google(audio)
                print(f"[USER]: {text}")
                return text.strip()
            except sr.WaitTimeoutError:
                return None
            except sr.UnknownValueError:
                print("[INFO]: Could not understand audio.")
                return ""
            except sr.RequestError as e:
                print(f"[ERROR]: Speech recognition service error — {e}")
                return ""


# ══════════════════════════════════════════════════
# 10. DAILY LOGGER
# ══════════════════════════════════════════════════
class DailyLogger:
    """Manages daily_log.json for routine and medicine tracking."""

    def __init__(self, filepath=LOG_FILE):
        self.filepath = filepath
        self._lock = threading.Lock()
        self._ensure_file()

    def _ensure_file(self):
        if not os.path.exists(self.filepath):
            with open(self.filepath, "w") as f:
                json.dump([], f, indent=2)

    def log_entry(self, event, response):
        """Append a timestamped log entry."""
        entry = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "time": datetime.now().strftime("%H:%M:%S"),
            "timestamp": datetime.now().isoformat(),
            "event": event,
            "response": response,
        }
        with self._lock:
            try:
                with open(self.filepath, "r") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                data = []
            data.append(entry)
            with open(self.filepath, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"[LOG]: Saved — {event}: {response}")
        
        # New API synchronization: Sync log with backend dashboard
        try:
            requests.post("http://127.0.0.1:5000/api/medicine", json={
                "lid_open": True, "reminder_triggered": True
            }, timeout=3)
        except Exception:
            pass

    def was_logged_today(self, event):
        """Check if an event was already logged today."""
        today = datetime.now().strftime("%Y-%m-%d")
        with self._lock:
            try:
                with open(self.filepath, "r") as f:
                    data = json.load(f)
            except (json.JSONDecodeError, FileNotFoundError):
                return False
            return any(e["date"] == today and e["event"] == event for e in data)


# ══════════════════════════════════════════════════
# 11. HEALTH SYMPTOM DETECTOR
# ══════════════════════════════════════════════════
def detect_health_symptom(text):
    """Check if user text mentions a health symptom. Returns symptom key or None."""
    text_lower = text.lower()
    for symptom_key, symptom_data in HEALTH_ADVICE.items():
        for keyword in symptom_data["keywords"]:
            if keyword in text_lower:
                return symptom_key
    return None


# ══════════════════════════════════════════════════
# 12. TIME PARSER — Convert spoken time to HH:MM
# ══════════════════════════════════════════════════
def parse_spoken_time(text):
    """Parse spoken time like '9 AM', '2:30 PM', 'morning 8' into 'HH:MM' format."""
    text_lower = text.lower().strip()

    # Try HH:MM format (e.g., "09:00", "14:30")
    match = re.search(r'(\d{1,2}):(\d{2})', text_lower)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"

    # Try "X AM/PM" format
    match = re.search(r'(\d{1,2})\s*(am|pm|a\.m|p\.m)', text_lower)
    if match:
        hour = int(match.group(1))
        period = match.group(2)
        if "p" in period and hour != 12:
            hour += 12
        elif "a" in period and hour == 12:
            hour = 0
        return f"{hour:02d}:00"

    # Try "morning/afternoon/evening/night X"
    match = re.search(r'(morning|afternoon|evening|night)\s*(\d{1,2})', text_lower)
    if match:
        period = match.group(1)
        hour = int(match.group(2))
        if period in ("afternoon", "evening") and hour < 12:
            hour += 12
        elif period == "night" and hour < 12:
            hour += 12
        return f"{hour:02d}:00"

    # Try "X morning/afternoon/evening/night"
    match = re.search(r'(\d{1,2})\s*(morning|afternoon|evening|night)', text_lower)
    if match:
        hour = int(match.group(1))
        period = match.group(2)
        if period in ("afternoon", "evening") and hour < 12:
            hour += 12
        elif period == "night" and hour < 12:
            hour += 12
        return f"{hour:02d}:00"

    # Try just a number
    match = re.search(r'(\d{1,2})', text_lower)
    if match:
        hour = int(match.group(1))
        if 0 <= hour <= 23:
            return f"{hour:02d}:00"

    return None


# ══════════════════════════════════════════════════
# 13. OLLAMA — Smart Two-Stage AI
# ══════════════════════════════════════════════════

def classify_intent(user_input, chat_memory=None):
    """
    Stage 1: Classify user intent into a category.
    Returns a dict with 'intent' and optional extracted data.
    """
    try:
        import ollama

        system_prompt = (
            "You are an intent classifier for an elder care voice assistant. "
            "Analyze the user's spoken input and return ONLY a valid JSON object with NO extra text.\n\n"
            "Possible intents:\n"
            '1. "box_query" — Asking about a medicine box. '
            '   Return: {"intent": "box_query", "box_number": <int>}\n'
            '2. "health_advice" — User mentions any health symptom, pain, illness, or disease. '
            '   Extract the symptom. '
            '   Return: {"intent": "health_advice", "symptom": "<symptom keyword>"}\n'
            '3. "add_medicine" — User wants to add/save/remember a new medicine. '
            '   Return: {"intent": "add_medicine"}\n'
            '4. "delete_medicine" — User wants to delete/remove a medicine. '
            '   Extract the medicine name if mentioned. '
            '   Return: {"intent": "delete_medicine", "medicine_name": "<name or empty>"}\n'
            '5. "list_medicines" — User wants to see/hear all their medicines. '
            '   Return: {"intent": "list_medicines"}\n'
            '6. "tell_joke" — User wants a joke or is bored. '
            '   Return: {"intent": "tell_joke"}\n'
            '7. "tell_news" — User wants to hear news headlines. '
            '   Return: {"intent": "tell_news"}\n'
            '8. "tell_weather" — User asks about the weather. '
            '   Return: {"intent": "tell_weather"}\n'
            '9. "yes" — Affirmative response. '
            '   Return: {"intent": "yes"}\n'
            '10. "no" — Negative response. '
            '   Return: {"intent": "no"}\n'
            '11. "greeting" — Greeting. '
            '   Return: {"intent": "greeting"}\n'
            '12. "exit" — Wants to stop/exit. '
            '   Return: {"intent": "exit"}\n'
            '13. "general" — Any other query or conversation. '
            '   Return: {"intent": "general"}\n\n'
            "IMPORTANT: Return ONLY the JSON object. No markdown, no explanation, no commentary."
        )

        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_input},
            ],
            options={"temperature": 0.1},
        )

        raw = response["message"]["content"].strip()
        # Clean markdown fencing
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
        if raw.endswith("```"):
            raw = raw.rsplit("```", 1)[0]
        raw = raw.strip()

        # Try to extract JSON from the response
        json_match = re.search(r'\{[^}]+\}', raw)
        if json_match:
            result = json.loads(json_match.group())
            return result

        result = json.loads(raw)
        return result

    except json.JSONDecodeError:
        print(f"[WARN]: Ollama returned non-JSON, using fallback.")
        return _fallback_intent(user_input)
    except ImportError:
        print("[WARN]: ollama package not installed. Using fallback.")
        return _fallback_intent(user_input)
    except Exception as e:
        print(f"[WARN]: Ollama error ({e}). Using fallback.")
        return _fallback_intent(user_input)


def chat_with_ollama(user_input, chat_memory, medicine_manager=None):
    """
    Stage 2: Get a smart, conversational response from Ollama.
    Uses chat history for context-aware answers.
    """
    try:
        import ollama

        # Build context about user's medicines
        med_context = ""
        if medicine_manager:
            meds = medicine_manager.get_all()
            if meds:
                med_lines = []
                for m in meds:
                    med_lines.append(f"- {m['name']}: {m['purpose']} (timing: {m.get('timing', 'not set')})")
                med_context = "\n\nUser's current medicines:\n" + "\n".join(med_lines)

        system_prompt = (
            "You are Mitra, a gentle, soft-spoken, and friendly AI healthcare companion. "
            "You speak to the user like a trusted family member would — with patience, love, and clear language. "
            "Keep your responses SHORT (2-4 sentences max) since they will be spoken aloud. "
            "Do NOT use bullet points, numbered lists, or markdown. Speak naturally.\n\n"
            "Your capabilities:\n"
            "- Give practical health advice and home remedies\n"
            "- Recommend common over-the-counter medicines for minor ailments\n"
            "- Help manage daily routines and medicine schedules\n"
            "- Provide emotional support and encourage the user\n"
            "- Remember what the user said earlier in the conversation\n\n"
            "Important rules:\n"
            "- Always recommend consulting a doctor for serious or persistent symptoms\n"
            "- Never diagnose diseases, only suggest common remedies\n"
            "- Be encouraging and positive\n"
            "- You are talking to Srijan Das, a first-semester ECE student at MAKAUT university.\n"
            "- Remember his projects like Circuit Bird and be a supportive friend.\n"
            f"- Current date and time: {datetime.now().strftime('%A, %B %d, %Y at %I:%M %p')}\n"
            f"{med_context}"
        )

        # Build messages with chat history
        messages = [{"role": "system", "content": system_prompt}]
        if chat_memory:
            messages.extend(chat_memory.get_ollama_messages())
        messages.append({"role": "user", "content": user_input})

        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=messages,
            options={"temperature": 0.7},
        )

        answer = response["message"]["content"].strip()
        # Clean up any markdown formatting
        answer = answer.replace("**", "").replace("*", "").replace("#", "")
        answer = re.sub(r'\d+\.\s', '', answer)  # Remove numbered list markers
        return answer

    except ImportError:
        return "I am your health care assistant. Please ask me about your medicines or health concerns."
    except Exception as e:
        print(f"[WARN]: Ollama conversation error ({e}).")
        return "I am sorry, I could not process that right now. Could you please repeat?"


def fetch_medicine_info_ollama(medicine_name):
    """Use Ollama to get information about a medicine."""
    try:
        import ollama

        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a pharmacist assistant. Given a medicine name, provide a brief "
                        "1-sentence description of what it is used for. Return ONLY the description, "
                        "nothing else. Example: 'Used for treating fever and pain relief'"
                    )
                },
                {"role": "user", "content": f"What is {medicine_name} used for?"},
            ],
            options={"temperature": 0.3},
        )
        purpose = response["message"]["content"].strip()
        # Clean up
        purpose = purpose.replace("**", "").replace("*", "")
        if len(purpose) > 200:
            purpose = purpose[:200]
        return purpose

    except Exception as e:
        print(f"[WARN]: Could not fetch medicine info from Ollama: {e}")
        return None


def fetch_medicine_info_web(medicine_name):
    """Try to fetch medicine info from the OpenFDA API."""
    if not HAS_REQUESTS:
        return None
    try:
        url = f"https://api.fda.gov/drug/label.json?search=openfda.brand_name:\"{medicine_name}\"&limit=1"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if "results" in data and len(data["results"]) > 0:
                result = data["results"][0]
                purpose = result.get("purpose", result.get("indications_and_usage", ["Unknown"]))
                if isinstance(purpose, list):
                    purpose = purpose[0]
                # Clean and shorten
                purpose = purpose[:200].strip()
                return f"Used for {purpose.lower()}" if not purpose.lower().startswith("used") else purpose
    except Exception as e:
        print(f"[WARN]: OpenFDA API error: {e}")
    return None


def fetch_medicine_info(medicine_name):
    """Fetch medicine purpose from Ollama (primary) or web API (fallback)."""
    # Try Ollama first (it's local and fast)
    info = fetch_medicine_info_ollama(medicine_name)
    if info:
        return info

    # Try web API
    info = fetch_medicine_info_web(medicine_name)
    if info:
        return info

    return f"General purpose medicine (details not available)"


# ══════════════════════════════════════════════════
# 14. FALLBACK INTENT PARSER
# ══════════════════════════════════════════════════
def _fallback_intent(text):
    """Enhanced keyword-based fallback when Ollama is unavailable."""
    text_lower = text.lower().strip()

    # ── Medicine management ──
    if any(kw in text_lower for kw in ["add medicine", "medicine update", "new medicine",
                                        "remember medicine", "save medicine", "add a medicine"]):
        return {"intent": "add_medicine"}

    if any(kw in text_lower for kw in ["delete medicine", "remove medicine", "forget medicine"]):
        # Try to extract medicine name
        for kw in ["delete ", "remove ", "forget "]:
            if kw in text_lower:
                name = text_lower.split(kw, 1)[-1].strip()
                return {"intent": "delete_medicine", "medicine_name": name}
        return {"intent": "delete_medicine", "medicine_name": ""}

    if any(kw in text_lower for kw in ["list medicine", "my medicine", "show medicine",
                                        "what medicine", "all medicine", "medicine list"]):
        return {"intent": "list_medicines"}

    # ── Health check (before general) ──
    symptom = detect_health_symptom(text)
    if symptom:
        return {"intent": "health_advice", "symptom": symptom}

    # ── Box queries ──
    for num in [1, 2, 3]:
        ordinals = {
            1: ["1st", "first", "box 1", "box one", "1 box"],
            2: ["2nd", "second", "box 2", "box two", "2 box"],
            3: ["3rd", "third", "box 3", "box three", "3 box"],
        }
        if any(kw in text_lower for kw in ordinals.get(num, [])):
            return {"intent": "box_query", "box_number": num}

    # ── Entertainment ──
    if any(kw in text_lower for kw in ["joke", "funny", "laugh", "bored", "boring",
                                        "entertain", "make me laugh"]):
        return {"intent": "tell_joke"}

    if any(kw in text_lower for kw in ["news", "headlines", "whats happening"]):
        return {"intent": "tell_news"}

    if any(kw in text_lower for kw in ["weather", "temperature", "rain", "hot outside",
                                        "cold outside", "sunny"]):
        return {"intent": "tell_weather"}

    # ── Yes / No ──
    if text_lower in ("yes", "yeah", "yep", "yup", "ha", "haan", "sure", "okay", "ok"):
        return {"intent": "yes"}
    if text_lower in ("no", "nah", "nope", "na", "nahi"):
        return {"intent": "no"}

    # ── Exit ──
    if any(w in text_lower for w in ["exit", "quit", "stop", "bye", "goodbye", "shut down"]):
        return {"intent": "exit"}

    # ── Greeting ──
    if any(w in text_lower for w in ["hello", "hi", "hey", "good morning", "good evening",
                                      "good afternoon", "good night", "namaste"]):
        return {"intent": "greeting"}

    return {"intent": "general"}


# ══════════════════════════════════════════════════
# 15. UTILITY FUNCTIONS — Weather, News
# ══════════════════════════════════════════════════
def fetch_weather(city=WEATHER_CITY):
    """Fetch current weather from wttr.in (free, no API key)."""
    if not HAS_REQUESTS:
        return "I cannot check the weather right now because the requests library is not installed."
    try:
        url = f"https://wttr.in/{city}?format=j1"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            current = data["current_condition"][0]
            temp_c = current["temp_C"]
            feels_like = current["FeelsLikeC"]
            humidity = current["humidity"]
            desc = current["weatherDesc"][0]["value"]

            # Get today's forecast
            today = data.get("weather", [{}])[0]
            max_temp = today.get("maxtempC", "?")
            min_temp = today.get("mintempC", "?")

            report = (
                f"The current weather in {city} is {desc} with a temperature of {temp_c} degrees Celsius. "
                f"It feels like {feels_like} degrees. "
                f"Humidity is {humidity} percent. "
                f"Today's high will be {max_temp} degrees and low will be {min_temp} degrees."
            )
            return report
    except Exception as e:
        print(f"[WARN]: Weather fetch error: {e}")
    return f"Sorry, I could not fetch the weather for {city} right now. Please try again later."


def fetch_news():
    """Fetch top news headlines from Times of India RSS feed."""
    if not HAS_REQUESTS or not HAS_XML:
        return "I cannot fetch news right now. The required libraries are not available."
    try:
        url = "https://timesofindia.indiatimes.com/rssfeedstopstories.cms"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            root = ET.fromstring(resp.content)
            items = root.findall(".//item")
            if items:
                headlines = []
                for i, item in enumerate(items[:5]):  # Top 5 headlines
                    title = item.find("title")
                    if title is not None and title.text:
                        headlines.append(f"Number {i+1}: {title.text.strip()}")

                if headlines:
                    intro = "Here are today's top news headlines. "
                    return intro + ". ".join(headlines)
    except Exception as e:
        print(f"[WARN]: News fetch error: {e}")
    return "Sorry, I could not fetch the news right now. Please try again later."


# ══════════════════════════════════════════════════
# 16. REMINDER SCHEDULER — Dynamic Medicine Support
# ══════════════════════════════════════════════════
class ReminderScheduler:
    """
    Background thread that checks every 30 seconds and
    queues reminders for routines and dynamically managed medicines.
    """

    def __init__(self, logger, medicine_manager):
        self.logger = logger
        self.medicine_manager = medicine_manager
        self.pending_reminders = []  # type: List[Dict]
        self._lock = threading.Lock()
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop_event.set()

    def get_pending(self):
        """Retrieve and clear pending reminders."""
        with self._lock:
            reminders = list(self.pending_reminders)
            self.pending_reminders.clear()
            return reminders

    def _run(self):
        triggered_today = set()  # type: set
        last_date = datetime.now().strftime("%Y-%m-%d")

        while not self._stop_event.is_set():
            now = datetime.now()
            current_date = now.strftime("%Y-%m-%d")

            # Reset at midnight
            if current_date != last_date:
                triggered_today.clear()
                last_date = current_date

            current_hm = (now.hour, now.minute)

            # —— Daily routine reminders ——
            for scheduled_time, prompt in DAILY_ROUTINES.items():
                event_key = "routine_{:02d}{:02d}".format(scheduled_time[0], scheduled_time[1])
                if (
                    current_hm == scheduled_time
                    and event_key not in triggered_today
                    and not self.logger.was_logged_today(event_key)
                ):
                    triggered_today.add(event_key)
                    with self._lock:
                        self.pending_reminders.append({
                            "type": "routine",
                            "event_key": event_key,
                            "prompt": prompt,
                        })

            # —— Dynamic medicine reminders (5 min before) ——
            med_schedule = self.medicine_manager.get_schedule()
            for scheduled_time, med in med_schedule.items():
                reminder_time = (
                    datetime(now.year, now.month, now.day, scheduled_time[0], scheduled_time[1])
                    - timedelta(minutes=REMINDER_ADVANCE_MINUTES)
                )
                reminder_hm = (reminder_time.hour, reminder_time.minute)
                event_key = "medicine_{}_{}".format(
                    med["name"].lower().replace(" ", "_"),
                    "{:02d}{:02d}".format(scheduled_time[0], scheduled_time[1])
                )

                if (
                    current_hm == reminder_hm
                    and event_key not in triggered_today
                    and not self.logger.was_logged_today(event_key)
                ):
                    triggered_today.add(event_key)
                    with self._lock:
                        self.pending_reminders.append({
                            "type": "medicine",
                            "event_key": event_key,
                            "prompt": (
                                "Reminder! In {} minutes, please take {} from Box {}. "
                                "It is {}. Have you taken it?".format(
                                    REMINDER_ADVANCE_MINUTES,
                                    med["name"],
                                    med.get("box_number", "?"),
                                    med["purpose"].lower()
                                )
                            ),
                            "medicine_name": med["name"],
                        })

            time.sleep(30)


# ══════════════════════════════════════════════════
# 17. MAIN ASSISTANT — Smart Healthcare Companion
# ══════════════════════════════════════════════════
class ElderCareAssistant:
    """
    Main assistant orchestrating:
      Speech → Ollama Intent → Smart Logic → TTS Output
    With conversation memory and dynamic medicine management.
    """

    def __init__(self):
        print("=" * 55)
        print("   ELDER CARE VOICE ASSISTANT v2.0")
        print("   Smart Healthcare Companion")
        print("   Powered by Ollama (Llama 3 8B)")
        print("=" * 55)

        print("[INIT]: Initializing voice engine...")
        self.voice = VoiceEngine()
        print("[INIT]: Initializing speech listener...")
        self.listener = VoiceListener()
        print("[INIT]: Initializing chat memory...")
        self.chat_memory = ChatMemory()
        print("[INIT]: Initializing medicine manager...")
        self.medicine_manager = MedicineManager()
        print("[INIT]: Initializing daily logger...")
        self.logger = DailyLogger()
        print("[INIT]: Initializing reminder scheduler...")
        self.scheduler = ReminderScheduler(self.logger, self.medicine_manager)
        self.is_sleeping = False
        self.running = True

        # Print loaded medicines
        meds = self.medicine_manager.get_all()
        print(f"[INIT]: Loaded {len(meds)} medicine(s):")
        for m in meds:
            print(f"         - {m['name']} at {m.get('timing', '?')} (Box {m.get('box_number', '?')})")

    def run(self):
        """Main event loop."""
        self.scheduler.start()
        self.voice.speak(
            "Hello Srijan! I am Mitra, your smart healthcare companion. "
            "I can help you with your medicines, health advice, daily routines, "
            "and even tell you jokes or the weather. Just talk to me!"
        )

        try:
            while self.running:
                # ── Handle pending reminders ──
                self._process_reminders()

                # ── Sleep mode ──
                if self.is_sleeping:
                    self._sleep_mode()
                    continue

                # ── Active listening ──
                self.voice.speak("I am listening.")
                user_text = self.listener.listen(timeout=SLEEP_TIMEOUT_SECONDS)

                if user_text is None:
                    self.voice.speak(
                        "I have not heard anything for a while. "
                        "Going to sleep. Press the G key to wake me up."
                    )
                    self.is_sleeping = True
                    continue

                if user_text == "":
                    self.voice.speak("Sorry, I did not catch that. Could you please repeat?")
                    continue

                # ── Save user message to memory ──
                self.chat_memory.add("user", user_text)

                # ── Process input ──
                self._handle_input(user_text)

        except KeyboardInterrupt:
            print("\n[INFO]: Interrupted by user.")
        finally:
            self.scheduler.stop()
            self.voice.speak("Goodbye, Srijan! Take care and stay healthy.")
            print("[INFO]: Assistant shut down.")

    # ── Sleep Mode ──────────────────────────────────
    def _sleep_mode(self):
        """Wait in sleep mode until G key pressed or a reminder fires."""
        print(f"[SLEEP]: Sleeping... Press '{WAKE_KEY.upper()}' to wake up.")
        while self.is_sleeping and self.running:
            reminders = self.scheduler.get_pending()
            if reminders:
                self.is_sleeping = False
                print("[WAKE]: Waking up for scheduled reminder!")
                for reminder in reminders:
                    self._handle_reminder(reminder)
                return

            if HAS_KEYBOARD:
                try:
                    if keyboard.is_pressed(WAKE_KEY):
                        self.is_sleeping = False
                        self.voice.speak("I am awake now! How can I help you, Srijan?")
                        time.sleep(0.5)
                        return
                except Exception:
                    pass

            time.sleep(0.2)

    # ── Reminders ──────────────────────────────────
    def _process_reminders(self):
        """Check and handle any pending scheduled reminders."""
        reminders = self.scheduler.get_pending()
        for reminder in reminders:
            self._handle_reminder(reminder)

    def _handle_reminder(self, reminder):
        """Speak a reminder and log the yes/no response."""
        prompt = reminder["prompt"]
        event_key = reminder["event_key"]

        self.voice.speak(prompt)
        self.voice.speak("Please say yes or no.")

        response = self._get_yes_no_response(max_attempts=3)
        if response is not None:
            self.logger.log_entry(event_key, "Yes" if response else "No")
            if response:
                self.voice.speak("Great! That has been noted. Thank you, Srijan.")
            else:
                self.voice.speak("Alright, I have noted that. Please do it soon for your health.")
        else:
            self.logger.log_entry(event_key, "No response")
            self.voice.speak("I did not get a clear response. I will ask again later.")

    def _get_yes_no_response(self, max_attempts=3):
        # type: (...) -> Optional[bool]
        """Listen for a yes/no response. Returns True, False, or None."""
        for attempt in range(max_attempts):
            self.voice.speak("I am listening.")
            text = self.listener.listen(timeout=15)
            if text is None or text == "":
                if attempt < max_attempts - 1:
                    self.voice.speak("I did not hear you. Please say yes or no.")
                continue

            intent = classify_intent(text)
            if intent.get("intent") == "yes":
                return True
            elif intent.get("intent") == "no":
                return False
            else:
                if attempt < max_attempts - 1:
                    self.voice.speak("Please respond with yes or no.")
        return None

    # ── Main Input Handler ──────────────────────────
    def _handle_input(self, user_text):
        """Classify intent and dispatch to the appropriate handler."""
        # First check for health symptoms directly (more reliable than Ollama for this)
        symptom = detect_health_symptom(user_text)

        # Classify intent via Ollama
        intent_data = classify_intent(user_text, self.chat_memory)
        intent = intent_data.get("intent", "general")

        # Override: if we detected a health symptom, prioritize health advice
        if symptom and intent not in ("exit", "yes", "no"):
            intent = "health_advice"
            intent_data["symptom"] = symptom

        print(f"[INTENT]: {intent} | Data: {intent_data}")

        if intent == "box_query":
            self._handle_box_query(intent_data)
        elif intent == "health_advice":
            self._handle_health_advice(intent_data, user_text)
        elif intent == "add_medicine":
            self._handle_add_medicine()
        elif intent == "delete_medicine":
            self._handle_delete_medicine(intent_data)
        elif intent == "list_medicines":
            self._handle_list_medicines()
        elif intent == "tell_joke":
            self._handle_joke()
        elif intent == "tell_news":
            self._handle_news()
        elif intent == "tell_weather":
            self._handle_weather()
        elif intent == "greeting":
            # Try Ollama for a warm greeting, fallback to a simple one
            response = chat_with_ollama(user_text, self.chat_memory, self.medicine_manager)
            if not response or "could not process" in response.lower():
                response = "Hello Srijan! I am doing great. How are you feeling today? I am here to help you with anything you need."
            self.voice.speak(response)
            self.chat_memory.add("assistant", response)
        elif intent == "exit":
            self.voice.speak("Are you sure you want me to stop?")
            confirmation = self._get_yes_no_response(max_attempts=2)
            if confirmation:
                self.running = False
            else:
                self.voice.speak("Okay, I will stay active for you.")
        elif intent == "yes":
            self.voice.speak("Noted! Is there anything else I can help you with?")
            self.chat_memory.add("assistant", "Noted! Anything else?")
        elif intent == "no":
            self.voice.speak("Alright. Let me know if you need anything, Srijan.")
            self.chat_memory.add("assistant", "Alright, I'm here if you need me.")
        elif intent == "general":
            self._handle_general(user_text)
        else:
            self._handle_general(user_text)

    # ── Box Query ──────────────────────────────────
    def _handle_box_query(self, intent_data):
        """Handle medicine box queries using dynamic medicine manager."""
        box_num = intent_data.get("box_number")
        if box_num:
            med = self.medicine_manager.get_by_box(box_num)
            if med:
                ordinal = {1: "1st", 2: "2nd", 3: "3rd"}.get(box_num, "{}th".format(box_num))
                response = (
                    "The {} box contains {}. It is {}. "
                    "You should take it at {}.".format(
                        ordinal, med["name"], med["purpose"].lower(),
                        med.get("timing", "the scheduled time")
                    )
                )
                self.voice.speak(response)
                self.chat_memory.add("assistant", response)
            else:
                self.voice.speak(
                    "There is no medicine assigned to box {} yet. "
                    "You can add one by saying 'medicine update'.".format(box_num)
                )
        else:
            self.voice.speak("Which box number would you like to know about?")

    # ── Health Advice ──────────────────────────────
    def _handle_health_advice(self, intent_data, user_text):
        """Handle health symptom queries with built-in KB + Ollama conversation."""
        symptom = intent_data.get("symptom", "")

        # Try to match in our health knowledge base
        matched_symptom = None
        if symptom:
            # Direct match
            if symptom in HEALTH_ADVICE:
                matched_symptom = symptom
            else:
                # Search by keyword
                matched_symptom = detect_health_symptom(symptom)

        if not matched_symptom:
            matched_symptom = detect_health_symptom(user_text)

        if matched_symptom and matched_symptom in HEALTH_ADVICE:
            advice_data = HEALTH_ADVICE[matched_symptom]

            # Speak the advice
            self.voice.speak(advice_data["advice"])

            # Speak recommended medicines
            if advice_data.get("medicines"):
                med_list = ", ".join(advice_data["medicines"])
                self.voice.speak(
                    "You can take these medicines: {}. "
                    "But please consult a doctor before taking any new medicine.".format(med_list)
                )

            # Speak warning
            if advice_data.get("warning"):
                self.voice.speak(advice_data["warning"])

            self.chat_memory.add("assistant", advice_data["advice"])
        else:
            # No match in KB, use Ollama for a smart response
            response = chat_with_ollama(user_text, self.chat_memory, self.medicine_manager)
            self.voice.speak(response)
            self.chat_memory.add("assistant", response)

    # ── Add Medicine ──────────────────────────────
    def _handle_add_medicine(self):
        """Voice-guided flow to add a new medicine."""
        self.voice.speak("Sure! Let us add a new medicine. What is the name of the medicine?")

        # Step 1: Get medicine name
        self.voice.speak("I am listening.")
        name_text = self.listener.listen(timeout=20)
        if not name_text:
            self.voice.speak("I did not hear the medicine name. Please try again later.")
            return

        medicine_name = name_text.strip()
        self.voice.speak("Got it. The medicine name is {}.".format(medicine_name))

        # Step 2: Get timing
        self.voice.speak("At what time should you take {}? Please say the time, like 9 AM or 2 PM.".format(medicine_name))
        self.voice.speak("I am listening.")
        time_text = self.listener.listen(timeout=20)
        if not time_text:
            self.voice.speak("I did not hear the timing. Please try again later.")
            return

        timing = parse_spoken_time(time_text)
        if not timing:
            self.voice.speak("I could not understand the time. Saving it without a specific time.")
            timing = "00:00"

        # Convert timing to readable format
        try:
            time_obj = datetime.strptime(timing, "%H:%M")
            readable_time = time_obj.strftime("%I:%M %p")
        except ValueError:
            readable_time = timing

        self.voice.speak("Got it. You need to take {} at {}.".format(medicine_name, readable_time))

        # Step 3: Fetch medicine info
        self.voice.speak("Let me look up information about {} for you.".format(medicine_name))
        purpose = fetch_medicine_info(medicine_name)

        # Step 4: Save
        med = self.medicine_manager.add(medicine_name, purpose, timing)

        self.voice.speak(
            "I have saved {} to your medicine list. {}. "
            "I will remind you to take it at {}. "
            "It has been assigned to Box {}.".format(
                medicine_name, purpose, readable_time, med.get("box_number", "?")
            )
        )

        self.chat_memory.add("assistant",
            "Added medicine: {} at {} - {}".format(medicine_name, readable_time, purpose)
        )
        print("[MEDICINE]: Added {} — {} — Timing: {}".format(medicine_name, purpose, timing))

    # ── Delete Medicine ──────────────────────────────
    def _handle_delete_medicine(self, intent_data):
        """Delete a medicine from the list."""
        medicine_name = intent_data.get("medicine_name", "").strip()

        if not medicine_name:
            # List medicines and ask which to delete
            meds = self.medicine_manager.get_all()
            if not meds:
                self.voice.speak("You have no medicines saved. There is nothing to delete.")
                return

            self.voice.speak("Here are your current medicines.")
            for i, med in enumerate(meds, 1):
                self.voice.speak("Number {}: {}.".format(i, med["name"]))

            self.voice.speak("Which medicine would you like to delete? Please say the name.")
            self.voice.speak("I am listening.")
            name_text = self.listener.listen(timeout=15)
            if not name_text:
                self.voice.speak("I did not hear the name. Please try again later.")
                return
            medicine_name = name_text.strip()

        # Try to delete
        if self.medicine_manager.delete(medicine_name):
            self.voice.speak(
                "{} has been removed from your medicine list. "
                "I will no longer remind you about it.".format(medicine_name)
            )
            self.chat_memory.add("assistant", "Deleted medicine: {}".format(medicine_name))
        else:
            self.voice.speak(
                "I could not find a medicine called {} in your list. "
                "Please check the name and try again.".format(medicine_name)
            )

    # ── List Medicines ──────────────────────────────
    def _handle_list_medicines(self):
        """Read out all saved medicines."""
        meds = self.medicine_manager.get_all()
        if not meds:
            self.voice.speak("You currently have no medicines saved. "
                           "Say 'medicine update' to add one.")
            return

        self.voice.speak("You have {} medicines in your list.".format(len(meds)))
        for i, med in enumerate(meds, 1):
            timing = med.get("timing", "not set")
            try:
                time_obj = datetime.strptime(timing, "%H:%M")
                readable_time = time_obj.strftime("%I:%M %p")
            except ValueError:
                readable_time = timing

            self.voice.speak(
                "Number {}: {}, taken at {}. It is {}.".format(
                    i, med["name"], readable_time, med["purpose"].lower()
                )
            )

        self.chat_memory.add("assistant",
            "Listed {} medicines".format(len(meds))
        )

    # ── Joke ──────────────────────────────────
    def _handle_joke(self):
        """Tell a random joke."""
        joke = random.choice(JOKES)
        self.voice.speak("Here is a joke for you!")
        self.voice.speak(joke)
        self.voice.speak("I hope that made you smile, Srijan!")
        self.chat_memory.add("assistant", "Told a joke: " + joke[:50])

    # ── Weather ──────────────────────────────────
    def _handle_weather(self):
        """Fetch and speak the current weather."""
        self.voice.speak("Let me check the weather for {} right now.".format(WEATHER_CITY))
        report = fetch_weather()
        self.voice.speak(report)
        self.chat_memory.add("assistant", "Weather report: " + report[:80])

    # ── News ──────────────────────────────────
    def _handle_news(self):
        """Fetch and speak top news headlines."""
        self.voice.speak("Let me fetch today's top news headlines for you.")
        news = fetch_news()
        self.voice.speak(news)
        self.chat_memory.add("assistant", "Read news headlines")

    # ── General Conversation ──────────────────────
    def _handle_general(self, user_text):
        """Handle general conversation using Ollama with full chat context."""
        response = chat_with_ollama(user_text, self.chat_memory, self.medicine_manager)
        if not response or "could not process" in response.lower():
            response = (
                "I am your healthcare companion Mitra. "
                "You can ask me about your medicines, health tips, "
                "the weather, news, or even a joke. How can I help you?"
            )
        self.voice.speak(response)
        self.chat_memory.add("assistant", response)


# ══════════════════════════════════════════════════
# 18. CENTRALIZED AI DICTATOR TRIGGERS & HTTP SERVER
# ══════════════════════════════════════════════════
from http.server import HTTPServer, BaseHTTPRequestHandler
import socket

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def register_with_server():
    server_ip = "10.206.196.135"  # Central Dashboard PC IP
    try:
        # Give a small 3-second delay to ensure local networking has fully initialized
        time.sleep(3)
        local_ip = get_local_ip()
        print(f"[INIT]: Local IP is {local_ip}. Registering with central dashboard...")
        import requests
        requests.post(f"http://{server_ip}:5050/api/assistant/heartbeat", json={
            "ip": local_ip,
            "port": 8080
        }, timeout=4)
        print("[INIT]: Registered successfully with central dashboard!")
    except Exception as e:
        print(f"[WARN]: Failed to register companion IP with dashboard: {e}")

def run_ai_dictation_walkthrough(payload):
    try:
        import ollama
        print("\n[DICTATOR]: Triggered! Compiling clinical patient health data...")
        
        patient_name = payload.get("patientName", "Somsubhro")
        bpm_history = payload.get("bpmHistory", [])
        fall_events = payload.get("fallEvents", [])
        medicines = payload.get("medicines", [])
        logs = payload.get("logs", [])
        
        bpm_vals = [b.get("bpm", b.get("value", 72)) for b in bpm_history if b]
        avg_bpm = sum(bpm_vals) / len(bpm_vals) if bpm_vals else 72
        max_bpm = max(bpm_vals) if bpm_vals else 72
        min_bpm = min(bpm_vals) if bpm_vals else 72
        
        active_falls = [f for f in fall_events if f.get("status") == "active"]
        
        med_list = []
        for m in medicines:
            med_list.append(f"{m.get('name')} ({m.get('dosage')}) scheduled at {', '.join(m.get('times', []))}")
        
        prompt = (
            f"You are Mitra, a professional clinical AI health assistant. Summarize this patient's data for the doctor:\n"
            f"Patient: {patient_name}\n"
            f"Vitals: Average Heart Rate {avg_bpm:.1f} BPM (Max {max_bpm}, Min {min_bpm})\n"
            f"Falls: {len(fall_events)} occurrences total, with {len(active_falls)} currently active/unresolved.\n"
            f"Prescriptions: {'; '.join(med_list)}\n"
            f"Recent logs: {', '.join([l.get('message') for l in logs[:3]])}\n\n"
            f"Provide a highly professional, structured, yet reassuring verbal summary for the physician. "
            f"Speak naturally, under 6 sentences. Do NOT use markdown list formatting."
        )
        
        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "user", "content": prompt}],
            options={"temperature": 0.3}
        )
        
        summary = response["message"]["content"].strip()
        summary = summary.replace("**", "").replace("*", "").replace("#", "")
        
        print("\n=== AI DICTATOR CLINICAL SUMMARY ===")
        print(summary)
        print("=====================================\n")
        
        # Physically read aloud using VoiceEngine
        voice = VoiceEngine()
        voice.speak(f"Doctor, here is the AI Dictator clinical summary for {patient_name}.")
        voice.speak(summary)
        
    except Exception as e:
        print(f"[ERROR]: AI Dictator walkthrough failed — {e}")

class TriggerHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/api/ai-dictator/trigger':
            try:
                content_length = int(self.headers['Content-Length'])
                post_data = self.rfile.read(content_length)
                payload = json.loads(post_data.decode('utf-8'))
                
                # Trigger AI dictation physically in a background thread so the HTTP response returns immediately
                threading.Thread(target=run_ai_dictation_walkthrough, args=(payload,), daemon=True).start()
                
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"success": True}).encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()
            
    def log_message(self, format, *args):
        # Suppress HTTP server logging in stdout to keep assistant log clean
        return

def start_trigger_server():
    try:
        server = HTTPServer(('0.0.0.0', 8080), TriggerHandler)
        print("[INIT]: AI Dictator HTTP trigger server listening on port 8080...")
        server.serve_forever()
    except Exception as e:
        print(f"[ERROR]: Failed to start HTTP trigger server: {e}")

# ══════════════════════════════════════════════════
# 19. ENTRY POINT
# ══════════════════════════════════════════════════
if __name__ == "__main__":
    print("[INFO]: Checking dependencies...")

    missing = []
    try:
        import speech_recognition
    except ImportError:
        missing.append("SpeechRecognition")
    try:
        import pyttsx3
    except ImportError:
        missing.append("pyttsx3")
    if not HAS_KEYBOARD:
        missing.append("keyboard (optional, physical G-key sleep wake-up will be disabled)")
    try:
        import requests
    except ImportError:
        missing.append("requests  (needed for weather/news features)")
    try:
        import ollama
        print(f"[INFO]: Ollama found. Using model: {OLLAMA_MODEL}")
    except ImportError:
        missing.append("ollama  (fallback mode will be used)")

    if missing:
        print("[WARN]: Missing packages:")
        for pkg in missing:
            print(f"         - {pkg}")
        print("         Install with: pip install SpeechRecognition pyttsx3 keyboard ollama pyaudio requests")
        if any(p in ["SpeechRecognition", "pyttsx3"] for p in missing):
            print("[ERROR]: Critical dependencies missing. Exiting.")
            exit(1)

    print("[INFO]: All critical dependencies OK.")
    print(f"[INFO]: Weather city: {WEATHER_CITY}")
    print(f"[INFO]: Ollama model: {OLLAMA_MODEL}")
    print(f"[INFO]: Medicines file: {MEDICINES_FILE}")
    print(f"[INFO]: Chat history file: {CHAT_HISTORY_FILE}")
    print(f"[INFO]: Log file: {LOG_FILE}")
    print("")

    # Start the HTTP trigger server for dashboard communications
    threading.Thread(target=start_trigger_server, daemon=True).start()
    
    # Register this companion IP address with the Express server dynamically
    threading.Thread(target=register_with_server, daemon=True).start()

    assistant = ElderCareAssistant()
    assistant.run()
