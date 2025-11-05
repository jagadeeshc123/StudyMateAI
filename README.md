# StudyMate - AI-Powered PDF Q&A System

StudyMate is an intelligent academic assistant that helps students interact with their study materials through natural language questions and answers.

## Features

- **PDF Upload & Processing**: Upload multiple PDF documents (textbooks, lecture notes, research papers)
- **Intelligent Text Extraction**: Automatic chunking and preprocessing of PDF content
- **Semantic Search**: Fast and accurate retrieval using FAISS vector database
- **AI-Powered Answers**: Context-aware responses using IBM Watsonx Mixtral-8x7B model
- **Source References**: Every answer includes references to source documents and page numbers
- **Document Management**: Easy management of uploaded PDFs
- **Q&A History**: Track all your questions and answers

## Setup Instructions

### Step 1: Install Required Packages

Due to package manager compatibility requirements, you need to manually install the required dependencies. Open the **Shell** tab and run:

```bash
uv pip install sentence-transformers ibm-watsonx-ai
```

After installation, refresh the StudyMate app page.

### Step 2: Get IBM Watsonx Credentials

1. Sign up for IBM Watsonx at: https://www.ibm.com/watsonx
2. Create a new project or use an existing one
3. Get your API credentials:
   - **API Key**: Found in your IBM Cloud account settings
   - **Project ID**: Found in your Watsonx project settings
   - **URL**: Usually `https://us-south.ml.cloud.ibm.com` (or your region's endpoint)

### Step 3: Configure the App

1. Open the StudyMate app
2. In the sidebar, enter your IBM Watsonx credentials:
   - API Key
   - Project ID
   - Watsonx URL
3. Click "Save Credentials"

## How to Use

### Uploading Documents

1. Go to the **Upload Documents** tab
2. Click "Choose PDF files" or drag and drop PDFs
3. Click "Process Documents" to extract and index the content
4. Wait for processing to complete

### Asking Questions

1. Go to the **Ask Questions** tab
2. Type your question in natural language
3. Adjust the number of source chunks if needed (1-5)
4. Click "Get Answer"
5. Review the answer and source references

### Managing Documents

1. Go to the **Document Manager** tab
2. View all uploaded documents with their statistics
3. Remove documents you no longer need

### Viewing History

1. Go to the **Q&A History** tab
2. Browse all your previous questions and answers
3. Review source references for each response

## Technologies Used

- **Python**: Core programming language
- **Streamlit**: Web interface framework
- **PyMuPDF (fitz)**: PDF text extraction
- **sentence-transformers**: Semantic embeddings
- **FAISS**: Vector similarity search
- **IBM Watsonx**: AI language model (Mixtral-8x7B-Instruct)

## Troubleshooting

### "Module not found" errors

If you see import errors, make sure you've run the installation command:
```bash
uv pip install sentence-transformers ibm-watsonx-ai
```

### Slow embedding generation

The first time you run the app, it downloads the sentence-transformers model (~80MB). This is a one-time download.

### IBM Watsonx authentication errors

- Verify your API key is correct
- Check that your project ID is valid
- Ensure you have access to the Mixtral model in your Watsonx project
- Confirm the URL matches your IBM Cloud region

### PDF processing fails

- Ensure your PDF contains extractable text (not scanned images)
- Try with smaller PDFs first to test the system
- Check that the PDF is not password-protected

## Performance Tips

- Upload related documents together for better context
- Use 3-5 source chunks for most questions (balance between context and speed)
- Keep document chunks manageable (the app auto-chunks large documents)
- Clear unused documents from the manager to improve search speed

## Privacy & Data

- All data is processed locally in your Replit environment
- PDFs are temporarily stored only during processing
- IBM Watsonx API calls follow IBM's data privacy policies
- No data is permanently stored beyond your session

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Verify all dependencies are installed correctly
3. Review the IBM Watsonx documentation
4. Check Replit console for error messages

## License

This project is created for educational purposes.
