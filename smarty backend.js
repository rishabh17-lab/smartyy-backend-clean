require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors({
  origin: 'https://rishabh17-lab.github.io'
}));

// Configure Multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and DOCX files are allowed.'));
    }
  }
});

// Initialize Gemini AI
let genAI;
try {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} catch (error) {
  console.error('Failed to initialize Gemini AI:', error.message);
  process.exit(1);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString()
  });
});

// Upload and parse resume
app.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let text;
    if (req.file.mimetype === 'application/pdf') {
      const data = await pdf(req.file.buffer);
      text = data.text;
    } else { // DOCX
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    }

    if (!text) {
      return res.status(400).json({ error: 'Could not extract text from file' });
    }

    const resumeData = parseResumeText(text);
    res.status(200).json(resumeData);
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: error.message || 'Failed to process resume' });
  }
});

// Analyze job description
app.post('/analyze-jd', async (req, res) => {
  try {
    const { jobDescription } = req.body;
    
    if (!jobDescription || typeof jobDescription !== 'string') {
      return res.status(400).json({ error: 'Invalid job description format' });
    }

    const jobData = analyzeJobDescription(jobDescription);
    res.status(200).json(jobData);
  } catch (error) {
    console.error('JD analysis error:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze job description' });
  }
});

// Generate cover letter
app.post('/generate', async (req, res) => {
  try {
    const { resumeData, jobDescription, tone = 'formal' } = req.body;

    if (!resumeData || !jobDescription) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const validTones = ['friendly', 'formal', 'confident'];
    if (!validTones.includes(tone)) {
      return res.status(400).json({ error: 'Invalid tone specified' });
    }

    const coverLetter = await generateCoverLetter(resumeData, jobDescription, tone);
    res.status(200).json({ coverLetter });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate cover letter' });
  }
});

// Helper functions
function parseResumeText(text) {
  // Basic parsing - in a real app you'd want more sophisticated parsing
  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
  const phoneMatch = text.match(/(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
  
  // Extract skills (simple approach - look for common skill keywords)
  const commonSkills = ['JavaScript', 'Python', 'Java', 'React', 'Node.js', 'SQL', 'AWS', 'HTML', 'CSS'];
  const skills = commonSkills.filter(skill => text.includes(skill));
  
  return {
    name: extractName(text),
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0] : null,
    skills: skills.length > 0 ? skills : ['Skills not detected'],
    experience: extractSection(text, 'experience'),
    education: extractSection(text, 'education')
  };
}

function extractName(text) {
  // Very basic name extraction - looks for the first line that looks like a name
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && trimmed.split(' ').length >= 2 && !trimmed.match(/[0-9]/)) {
      return trimmed;
    }
  }
  return 'Your Name';
}

function extractSection(text, section) {
  // Simple section extraction - looks for section headers
  const sectionRegex = new RegExp(`${section}[\\s:]+([\\s\\S]+?)(?:\\n\\n|$)`, 'i');
  const match = text.match(sectionRegex);
  return match ? match[1].trim() : `${section} section not detected`;
}

function analyzeJobDescription(jd) {
  // Basic job description analysis
  const companyMatch = jd.match(/(?:at|from)\s+([A-Z][a-zA-Z0-9\s&-]+)(?:\s|$)/i);
  const roleMatch = jd.match(/(?:looking for|seeking|position of)\s+([a-zA-Z\s]+)(?:\sto|$)/i);
  
  // Extract requirements (simple approach)
  const requirements = [];
  const reqLines = jd.split('\n').filter(line => 
    line.toLowerCase().includes('require') || 
    line.toLowerCase().includes('must have') ||
    line.toLowerCase().includes('qualification')
  );
  
  reqLines.forEach(line => {
    const bulletPoints = line.split(/[-•]/).slice(1);
    bulletPoints.forEach(point => {
      const trimmed = point.trim();
      if (trimmed) requirements.push(trimmed);
    });
  });
  
  return {
    company: companyMatch ? companyMatch[1].trim() : 'Company Name Not Found',
    role: roleMatch ? roleMatch[1].trim() : 'Job Role Not Found',
    requirements: requirements.length > 0 ? requirements : ['Key requirements not explicitly listed']
  };
}

async function generateCoverLetter(resumeData, jobDescription, tone) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-pro" });
    
    const prompt = `
      Write a professional cover letter (250-400 words) with a ${tone} tone using the following details:
      
      Applicant Information:
      - Name: ${resumeData.name}
      - Skills: ${resumeData.skills.join(', ')}
      - Experience: ${resumeData.experience}
      - Education: ${resumeData.education}
      
      Job Description:
      ${jobDescription}
      
      Guidelines:
      1. Address the hiring manager appropriately (use "Dear Hiring Manager" if name is unknown)
      2. Highlight relevant skills and experiences that match the job requirements
      3. Maintain a ${tone} tone throughout
      4. Keep it concise (3-4 paragraphs)
      5. End with a professional closing
    `;
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    return text;
  } catch (error) {
    console.error('Gemini API error:', error);
    throw new Error('Failed to generate cover letter. Please check your API key and try again.');
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});