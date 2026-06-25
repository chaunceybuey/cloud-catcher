import os
import markdown2
from ebooklib import epub
from google import genai
from dotenv import load_dotenv

# Load the secret keys from your .env file
load_dotenv()

# =====================================================================
# SYSTEM PATHS
# =====================================================================
HOME_DIR = os.path.expanduser("~")
SUPERNOTE_ACADEMIC_FOLDER = os.path.join(
    HOME_DIR, 
    "Library", "CloudStorage", 
    "GoogleDrive-slottaj@gmail.com", "My Drive", "Supernote", "Document", "Drive", "Academic"
)

# Initialize the AI Client securely using the environment variable
client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))

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
    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=[pdf_file, prompt]
    )
    
    print("[ACADEMIC SYNC] Converting text to EPUB...")
    # Convert the clean Markdown into HTML
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
    
    safe_title = title.replace("/", "-").replace(":", "")
    output_path = os.path.join(SUPERNOTE_ACADEMIC_FOLDER, f"{safe_title}.epub")
    
    epub.write_epub(output_path, book, {})
    print(f"[ACADEMIC SYNC] Success! Saved to: {output_path}")
    
    # Wake up Google Drive to force the Supernote sync
    os.system("osascript -e 'tell application \"Google Drive\" to activate'")

if __name__ == "__main__":
    # Pointing to a test file on your Desktop
    pdf_path = os.path.expanduser("~/Desktop/paper.pdf")
    pdf_to_epub(pdf_path, "Social Cultivation of Vaccine Refusal")
