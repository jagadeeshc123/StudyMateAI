import streamlit as st
import fitz
import os
import tempfile
import numpy as np
from typing import List, Dict, Tuple
import json

try:
    from sentence_transformers import SentenceTransformer
    SENTENCE_TRANSFORMERS_AVAILABLE = True
except ImportError:
    SENTENCE_TRANSFORMERS_AVAILABLE = False

try:
    import faiss
    FAISS_AVAILABLE = True
except ImportError:
    FAISS_AVAILABLE = False

try:
    from ibm_watsonx_ai.foundation_models import Model
    from ibm_watsonx_ai import Credentials
    IBM_WATSONX_AVAILABLE = True
except ImportError:
    IBM_WATSONX_AVAILABLE = False

st.set_page_config(
    page_title="StudyMate - AI-Powered PDF Q&A",
    page_icon="📚",
    layout="wide"
)

def initialize_session_state():
    if 'documents' not in st.session_state:
        st.session_state.documents = []
    if 'text_chunks' not in st.session_state:
        st.session_state.text_chunks = []
    if 'embeddings' not in st.session_state:
        st.session_state.embeddings = None
    if 'faiss_index' not in st.session_state:
        st.session_state.faiss_index = None
    if 'embedding_model' not in st.session_state:
        st.session_state.embedding_model = None
    if 'qa_history' not in st.session_state:
        st.session_state.qa_history = []
    if 'watsonx_configured' not in st.session_state:
        st.session_state.watsonx_configured = False

def extract_text_from_pdf(pdf_file) -> List[Dict]:
    chunks = []
    with tempfile.NamedTemporaryFile(delete=False, suffix='.pdf') as tmp_file:
        tmp_file.write(pdf_file.getvalue())
        tmp_path = tmp_file.name
    
    try:
        doc = fitz.open(tmp_path)
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text()
            
            text_parts = text.split('\n\n')
            for part in text_parts:
                part = part.strip()
                if len(part) > 50:
                    chunks.append({
                        'text': part,
                        'source': pdf_file.name,
                        'page': page_num + 1
                    })
        doc.close()
    finally:
        os.unlink(tmp_path)
    
    return chunks

def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> List[str]:
    words = text.split()
    chunks = []
    
    for i in range(0, len(words), chunk_size - overlap):
        chunk = ' '.join(words[i:i + chunk_size])
        if len(chunk) > 50:
            chunks.append(chunk)
    
    return chunks

def get_embedding_model():
    if not SENTENCE_TRANSFORMERS_AVAILABLE:
        return None
    if st.session_state.embedding_model is None:
        with st.spinner('Loading embedding model...'):
            st.session_state.embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
    return st.session_state.embedding_model

def create_embeddings_and_index(chunks: List[Dict]) -> bool:
    if not SENTENCE_TRANSFORMERS_AVAILABLE or not FAISS_AVAILABLE:
        st.error("Cannot create embeddings: sentence-transformers and faiss-cpu are required. Please install them first.")
        return False
    
    model = get_embedding_model()
    if model is None:
        return False
    
    texts = [chunk['text'] for chunk in chunks]
    with st.spinner('Creating embeddings...'):
        embeddings = model.encode(texts, show_progress_bar=False)
    
    dimension = embeddings.shape[1]
    index = faiss.IndexFlatL2(dimension)
    index.add(embeddings.astype('float32'))
    
    st.session_state.embeddings = embeddings
    st.session_state.faiss_index = index
    st.session_state.text_chunks = chunks
    return True

def search_similar_chunks(query: str, top_k: int = 3) -> List[Dict]:
    if not SENTENCE_TRANSFORMERS_AVAILABLE or not FAISS_AVAILABLE:
        return []
    
    if st.session_state.faiss_index is None:
        return []
    
    model = get_embedding_model()
    if model is None:
        return []
    
    query_embedding = model.encode([query])
    
    distances, indices = st.session_state.faiss_index.search(
        query_embedding.astype('float32'), top_k
    )
    
    results = []
    for idx, dist in zip(indices[0], distances[0]):
        if idx >= 0 and idx < len(st.session_state.text_chunks):
            chunk = st.session_state.text_chunks[idx].copy()
            chunk['similarity_score'] = float(1 / (1 + dist))
            results.append(chunk)
    
    return results

def get_watsonx_answer(question: str, context_chunks: List[Dict]) -> str:
    if not IBM_WATSONX_AVAILABLE:
        return "IBM Watsonx AI library is not installed. Please run: uv pip install ibm-watsonx-ai"
    
    if not st.session_state.watsonx_configured:
        return "Please configure IBM Watsonx credentials in the sidebar to get AI-powered answers."
    
    context_text = "\n\n".join([
        f"[Source: {chunk['source']}, Page {chunk['page']}]\n{chunk['text']}"
        for chunk in context_chunks
    ])
    
    prompt = f"""You are an intelligent academic assistant helping students understand their study materials. Based on the following context from the student's documents, provide a clear and accurate answer to their question.

Context:
{context_text}

Question: {question}

Instructions:
- Provide a clear, direct answer based on the context above
- If the context doesn't contain enough information to answer fully, acknowledge this
- Reference specific sources and page numbers when relevant
- Be concise but thorough

Answer:"""
    
    try:
        api_key = st.session_state.get('watsonx_api_key', '')
        project_id = st.session_state.get('watsonx_project_id', '')
        url = st.session_state.get('watsonx_url', 'https://us-south.ml.cloud.ibm.com')
        
        credentials = Credentials(
            url=url,
            api_key=api_key
        )
        
        model = Model(
            model_id="mistralai/mixtral-8x7b-instruct-v01",
            credentials=credentials,
            project_id=project_id,
            params={
                "decoding_method": "greedy",
                "max_new_tokens": 500,
                "temperature": 0.7,
                "repetition_penalty": 1.1
            }
        )
        
        response = model.generate_text(prompt=prompt)
        return response
        
    except Exception as e:
        return f"Error generating answer: {str(e)}\n\nPlease check your IBM Watsonx credentials and try again."

def main():
    initialize_session_state()
    
    st.title("📚 StudyMate")
    st.subheader("AI-Powered PDF-Based Q&A System for Students")
    
    missing_packages = []
    if not SENTENCE_TRANSFORMERS_AVAILABLE:
        missing_packages.append("sentence-transformers")
    if not FAISS_AVAILABLE:
        missing_packages.append("faiss-cpu")
    if not IBM_WATSONX_AVAILABLE:
        missing_packages.append("ibm-watsonx-ai")
    
    if missing_packages:
        st.warning(f"⚠️ Setup Required: The following packages need to be installed manually:")
        st.code(f"# Run this command in the Shell:\nuv pip install {' '.join(missing_packages)}")
        st.info("After installation, refresh this page. The app will work with limited functionality until all packages are installed.")
        st.markdown("---")
    
    with st.sidebar:
        st.header("⚙️ Configuration")
        
        st.markdown("### IBM Watsonx Settings")
        watsonx_api_key = st.text_input(
            "API Key",
            type="password",
            value=st.session_state.get('watsonx_api_key', ''),
            help="Your IBM Watsonx API key"
        )
        watsonx_project_id = st.text_input(
            "Project ID",
            value=st.session_state.get('watsonx_project_id', ''),
            help="Your IBM Watsonx project ID"
        )
        watsonx_url = st.text_input(
            "Watsonx URL",
            value=st.session_state.get('watsonx_url', 'https://us-south.ml.cloud.ibm.com'),
            help="IBM Watsonx API endpoint URL"
        )
        
        if st.button("Save Credentials"):
            if watsonx_api_key and watsonx_project_id:
                st.session_state.watsonx_api_key = watsonx_api_key
                st.session_state.watsonx_project_id = watsonx_project_id
                st.session_state.watsonx_url = watsonx_url
                st.session_state.watsonx_configured = True
                st.success("✅ Credentials saved!")
            else:
                st.error("Please provide both API Key and Project ID")
        
        st.markdown("---")
        st.markdown("### Document Statistics")
        st.metric("Uploaded Documents", len(st.session_state.documents))
        st.metric("Text Chunks", len(st.session_state.text_chunks))
        st.metric("Questions Asked", len(st.session_state.qa_history))
    
    tabs = st.tabs(["📤 Upload Documents", "❓ Ask Questions", "📋 Document Manager", "💬 Q&A History"])
    
    with tabs[0]:
        st.header("Upload Your Study Materials")
        st.markdown("Upload one or more PDF documents (textbooks, lecture notes, research papers)")
        
        uploaded_files = st.file_uploader(
            "Choose PDF files",
            type=['pdf'],
            accept_multiple_files=True,
            help="You can upload multiple PDFs at once"
        )
        
        if uploaded_files:
            if st.button("Process Documents", type="primary"):
                all_chunks = []
                
                progress_bar = st.progress(0)
                status_text = st.empty()
                
                for idx, uploaded_file in enumerate(uploaded_files):
                    status_text.text(f"Processing: {uploaded_file.name}...")
                    
                    if uploaded_file.name not in [doc['name'] for doc in st.session_state.documents]:
                        chunks = extract_text_from_pdf(uploaded_file)
                        all_chunks.extend(chunks)
                        
                        st.session_state.documents.append({
                            'name': uploaded_file.name,
                            'size': uploaded_file.size,
                            'chunks': len(chunks)
                        })
                    
                    progress_bar.progress((idx + 1) / len(uploaded_files))
                
                if all_chunks:
                    status_text.text("Creating embeddings and search index...")
                    all_existing_chunks = st.session_state.text_chunks + all_chunks
                    success = create_embeddings_and_index(all_existing_chunks)
                    
                    progress_bar.empty()
                    status_text.empty()
                    if success:
                        st.success(f"✅ Successfully processed {len(uploaded_files)} document(s)!")
                        st.rerun()
                    else:
                        st.warning("Documents uploaded but embeddings not created. Please install required packages and try again.")
    
    with tabs[1]:
        st.header("Ask Questions About Your Documents")
        
        if not st.session_state.documents:
            st.info("👆 Please upload some PDF documents first in the 'Upload Documents' tab")
        else:
            question = st.text_area(
                "What would you like to know?",
                placeholder="Example: What are the main concepts discussed in chapter 3?",
                height=100
            )
            
            col1, col2 = st.columns([1, 5])
            with col1:
                ask_button = st.button("Get Answer", type="primary")
            with col2:
                num_sources = st.slider("Number of source chunks", 1, 5, 3)
            
            if ask_button and question:
                with st.spinner("Searching documents..."):
                    relevant_chunks = search_similar_chunks(question, top_k=num_sources)
                
                if relevant_chunks:
                    st.markdown("### 📖 Relevant Sources")
                    for i, chunk in enumerate(relevant_chunks, 1):
                        with st.expander(f"Source {i}: {chunk['source']} (Page {chunk['page']}) - Relevance: {chunk['similarity_score']:.2%}"):
                            st.markdown(chunk['text'])
                    
                    st.markdown("### 🤖 AI Answer")
                    with st.spinner("Generating answer..."):
                        answer = get_watsonx_answer(question, relevant_chunks)
                    
                    st.markdown(answer)
                    
                    st.session_state.qa_history.append({
                        'question': question,
                        'answer': answer,
                        'sources': relevant_chunks
                    })
                else:
                    st.warning("No relevant information found. Try rephrasing your question.")
    
    with tabs[2]:
        st.header("Document Manager")
        
        if not st.session_state.documents:
            st.info("No documents uploaded yet")
        else:
            for idx, doc in enumerate(st.session_state.documents):
                col1, col2, col3, col4 = st.columns([3, 1, 1, 1])
                
                with col1:
                    st.text(f"📄 {doc['name']}")
                with col2:
                    st.text(f"{doc['size'] / 1024:.1f} KB")
                with col3:
                    st.text(f"{doc['chunks']} chunks")
                with col4:
                    if st.button("Remove", key=f"remove_{idx}"):
                        st.session_state.text_chunks = [
                            chunk for chunk in st.session_state.text_chunks
                            if chunk['source'] != doc['name']
                        ]
                        st.session_state.documents.pop(idx)
                        
                        if st.session_state.text_chunks:
                            create_embeddings_and_index(st.session_state.text_chunks)
                        else:
                            st.session_state.faiss_index = None
                            st.session_state.embeddings = None
                        
                        st.rerun()
    
    with tabs[3]:
        st.header("Q&A History")
        
        if not st.session_state.qa_history:
            st.info("No questions asked yet")
        else:
            for idx, qa in enumerate(reversed(st.session_state.qa_history), 1):
                with st.expander(f"Q{len(st.session_state.qa_history) - idx + 1}: {qa['question'][:100]}..."):
                    st.markdown("**Question:**")
                    st.markdown(qa['question'])
                    st.markdown("**Answer:**")
                    st.markdown(qa['answer'])
                    st.markdown("**Sources:**")
                    for source in qa['sources']:
                        st.caption(f"- {source['source']} (Page {source['page']})")

if __name__ == "__main__":
    main()
