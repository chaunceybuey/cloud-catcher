import os
import json
import time
import markdown2
from ebooklib import epub
from google import genai
from dotenv import load_dotenv

# Load the secret keys from your .env file
load_dotenv()

# =====================================================================
# SYSTEM PATHS (User-Agnostic)
# =====================================================================
HOME_DIR = os.path.expanduser("~")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 1. The Input Folder (Paperpile Starred Papers)
DROPZONE_FOLDER = os.path.join(
    HOME_DIR, "Library", "CloudStorage", 
    "GoogleDrive-slottaj@gmail.com", "My Drive", "Miscellaneous", "Paperpile", "Starred Papers"
)

# 2. The Output Folder (Where the EPUBs go)
SUPERNOTE_ACADEMIC_FOLDER = os.path.join(
    HOME_DIR, "Library", "CloudStorage", 
    "GoogleDrive-slottaj@gmail.com", "My Drive", "Supernote", "Document", "Drive", "Academic"
)

# 3. The Memory Ledger (Keeps track of processed files in the code folder)
LEDGER_PATH = os.path.join(BASE_DIR, "academic_ledger.json")

# Initialize the AI Client securely using the environment variable
client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

def load_ledger():
    if os.path.exists(LEDGER_PATH):
        try:
            with open(LEDGER_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_ledger(ledger):
    with open(LEDGER_PATH, "w", encoding="utf-8") as f:
        json.dump(ledger, f, indent=4)

def pdf_to_epub(pdf_path, title):
    os.makedirs(SUPERNOTE_ACADEMIC_FOLDER, exist_ok=True)
    
    print(f"[ACADEMIC SYNC] Uploading '{title}'...")
    pdf_file = client.files.upload(file=pdf_path)
    
    prompt = """
    Extract all the text from this academic PDF and format it as clean Markdown. 
    Ignore all headers, footers, and page numbers. 
    Convert multi-column layouts into a single, flowing stream of text. 
    Preserve headings, math equations, and paragraph breaks.
    """
    
    print("[ACADEMIC SYNC] Parsing PDF with AI (this takes a few seconds)...")
    
    # =================================================================
    # The Auto-Retry Armor
    # =================================================================
    max_retries = 3
    response = None
    for attempt in range(max_retries):
        try:
            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[pdf_file, prompt]
            )
            break # Success! Break out of the loop.
            
        except Exception as e:
            if "503" in str(e) and attempt < max_retries - 1:
                print(f"[ACADEMIC SYNC] Gemini API is busy. Retrying in 5 seconds (Attempt {attempt + 2}/{max_retries})...")
                time.sleep(5)
            else:
                print(f"[ACADEMIC SYNC] AI API Error: {e}")
                raise e # Throw the error up so the ledger doesn't falsely mark it as complete
    # =================================================================
    
    print("[ACADEMIC SYNC] Converting text to EPUB...")
    html_content = markdown2.markdown(response.text)
    
    # Build the EPUB Book
    book = epub.EpubBook()
    book.set_title(title)
    book.set_language("en")
    
    chapter = epub.EpubHtml(title=title, file_name="article.xhtml", lang="en")
    chapter.content = f"<h1 style='font-family:serif;'>{title}</h1><hr/>" + html_content
    
    book.add_item(chapter)
    book.spine = ["nav", chapter]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    
    safe_title = title.replace("/", "-").replace(":", "")[:100]
    output_path = os.path.join(SUPERNOTE_ACADEMIC_FOLDER, f"{safe_title}.epub")
    
    epub.write_epub(output_path, book, {})
    print(f"[ACADEMIC SYNC] Success! Saved to: {output_path}")

def scan_dropzone():
    # Ensure the target directory exists before scanning
    if not os.path.exists(DROPZONE_FOLDER):
        print(f"[ACADEMIC SYNC] Target folder not found yet: {DROPZONE_FOLDER}")
        return

    ledger = load_ledger()
    new_files_processed = False
    
    # Give the cloud sync engine a brief 5-second window to completely write incoming files
    time.sleep(5) 

    for filename in os.listdir(DROPZONE_FOLDER):
        if filename.lower().endswith(".pdf") and filename not in ledger:
            pdf_path = os.path.join(DROPZONE_FOLDER, filename)
            title = filename.replace(".pdf", "").replace(".PDF", "")
            
            try:
                pdf_to_epub(pdf_path, title)
                ledger.append(filename)
                save_ledger(ledger)
                new_files_processed = True
            except Exception as e:
                print(f"[ACADEMIC SYNC] Error processing '{filename}': {e}")
                
    if new_files_processed:
        # Wake up Google Drive to force the Supernote sync
        os.system("osascript -e 'tell application \"Google Drive\" to activate'")
        print("[ACADEMIC SYNC] Dropzone processing cycle complete.")
    else:
        print("[ACADEMIC SYNC] Scan finished. No new un-indexed papers found.")

if __name__ == "__main__":
    scan_dropzone()