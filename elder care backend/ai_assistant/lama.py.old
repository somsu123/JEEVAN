import speech_recognition as sr
import pyttsx3
import ollama
import datetime
import json
import os

# ১. মেমোরি ফাইল সেটিংস (Chat history save করার জন্য)
MEMORY_FILE = "long_term_memory.json"

def load_memory():
    if os.path.exists(MEMORY_FILE):
        try:
            with open(MEMORY_FILE, 'r') as f:
                return json.load(f)
        except: return []
    return []

def save_memory(history):
    # মেমোরি যাতে খুব বড় না হয়ে যায়, তাই শেষ ২০টি মেসেজ সেভ করবে
    with open(MEMORY_FILE, 'w') as f:
        json.dump(history[-20:], f)

chat_history = load_memory()

def speak(text):
    if not text.strip(): return
    print(f"AI: {text}")
    engine = pyttsx3.init('sapi5')
    voices = engine.getProperty('voices')
    # voices[1] থাকলে ফিমেল সফট ভয়েস ব্যবহার করবে
    engine.setProperty('voice', voices[1].id if len(voices) > 1 else voices[0].id)
    engine.setProperty('rate', 165) 
    engine.say(text)
    engine.runAndWait()
    engine.stop()

def listen():
    r = sr.Recognizer()
    with sr.Microphone() as source:
        print("\nListening...")
        r.pause_threshold = 1.2
        r.adjust_for_ambient_noise(source, duration=0.8)
        audio = r.listen(source)
    try:
        query = r.recognize_google(audio, language='en-in')
        print(f"You: {query}")
        return query.lower()
    except: return "none"

if __name__ == "__main__":
    # বর্তমান সময় ও তারিখ নেওয়া
    now = datetime.datetime.now()
    current_time = now.strftime("%I:%M %p")
    current_date = now.strftime("%B %d, %Y")

    # শুরুতে ওয়েলকাম মেসেজ
    if not chat_history:
        speak(f"Hello Srijan. It is {current_time}. I am your new AI friend. I will remember everything we talk about.")
    else:
        speak(f"Welcome back Srijan. It is {current_time}. I remember our previous chats. How can I help you today?")

    while True:
        query = listen()
        
        if 'stop' in query or 'exit' in query:
            speak("Goodbye Srijan. See you soon!")
            save_memory(chat_history)
            break
            
        if query != "none":
            # ওলামাকে বর্তমান সময়ের তথ্য পাঠানো যাতে সে ভুল না বলে
            time_context = f"\n[System Info: Current local time is {current_time}, Date is {current_date}]"
            
            chat_history.append({'role': 'user', 'content': query + time_context})
            
            try:
                # সিস্টেমে তোমার পার্সোনাল ডিটেইলস দিয়ে দেওয়া হলো
                system_instruction = (
                    "You are a gentle, soft-spoken, and friendly AI. You are talking to Srijan Das, "
                    "a first-semester ECE student at MAKAUT university. You must use the provided system time "
                    "to answer questions about time. Remember his projects like Circuit Bird and be a supportive friend."
                )
                
                response = ollama.chat(model='llama3', messages=[
                    {'role': 'system', 'content': system_instruction}
                ] + chat_history)
                
                aimessage = response['message']['content']
                chat_history.append({'role': 'assistant', 'content': aimessage})
                
                # প্রতিবার কথা বলার পর অটো-সেভ হবে
                save_memory(chat_history)
                speak(aimessage)
                
            except Exception as e:
                print(f"Error: {e}")
                speak("I am sorry, I am having trouble connecting to my brain.")
