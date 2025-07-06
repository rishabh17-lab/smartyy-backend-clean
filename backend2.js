// server.js - AI Cover Letter Generator Backend (Production-Ready)
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const winston = require('winston');
const { body, validationResult } = require('express-validator');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');

// Initialize Express app
const app = express();

// Configuration
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_1DP5mmOlF5G5ag';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/smartyy';
const ALLOWED_FILE_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

// Configure logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple()
  }));
}

// Connect to MongoDB
//mongoose.connect(MONGODB_URI)
 // .then(() => logger.info('Connected to MongoDB'))
  //.catch(err => logger.error('MongoDB connection error:', err));

// Define MongoDB schemas
//const RequestLog = mongoose.model('RequestLog', new mongoose.Schema({
 // endpoint: String,
 // ip: String,
 // timestamp: { type: Date, default: Date.now },
 // userAgent: String
//}));

//const Payment = mongoose.model('Payment', new mongoose.Schema({
  //paymentId: String,
  //amount: Number,
  //currency: String,
 // status: String,
 // userId: String,
 // timestamp: { type: Date, default: Date.now }
//}));

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later'
});
app.use(limiter);

// Request logging middleware
app.use(async (req, res, next) => {
  try {
    await RequestLog.create({
      endpoint: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent')
    });
    next();
  } catch (err) {
    logger.error('Request logging failed:', err);
    next();
  }
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (ALLOWED_FILE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF and DOCX files are allowed.'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

// Payment verification middleware
const verifyPayment = async (req, res, next) => {
  try {
    const { paymentId, promoCode } = req.body;
    
    // Check for valid promo code
    if (promoCode === '070605') {
      logger.info('Promo code used for free access');
      return next();
    }

    if (!paymentId) {
      return res.status(403).json({ 
        error: 'Payment required',
        message: 'Please complete payment to generate cover letter'
      });
    }

    const payment = await razorpay.payments.fetch(paymentId);
    if (payment.status !== 'captured') {
      return res.status(403).json({ 
        error: 'Payment not completed',
        message: 'Your payment was not successful'
      });
    }

    // Log successful payment
    await Payment.create({
      paymentId: payment.id,
      amount: payment.amount / 100,
      currency: payment.currency,
      status: payment.status,
      userId: req.body.resumeData?.email || 'unknown'
    });

    next();
  } catch (error) {
    logger.error('Payment verification failed:', error);
    res.status(500).json({ 
      error: 'Payment verification failed',
      message: 'Could not verify your payment'
    });
  }
};

/**
 * POST /upload
 * Handles resume file upload and parsing
 */
app.post('/upload', upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) {
      logger.warn('No file uploaded');
      return res.status(400).json({ 
        error: 'No file uploaded',
        message: 'Please upload your resume file',
        allowedTypes: ALLOWED_FILE_TYPES
      });
    }

    let textContent;
    const fileBuffer = req.file.buffer;

    // Parse based on file type
    if (req.file.mimetype === 'application/pdf') {
      const data = await pdf(fileBuffer);
      textContent = data.text;
    } else { // DOCX
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      textContent = result.value;
    }

    // Extract structured data from resume text
    const resumeData = extractResumeData(textContent);
    
    logger.info('Resume processed successfully', { email: resumeData.email });
    res.json({
      success: true,
      data: resumeData
    });
  } catch (error) {
    logger.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Error processing resume',
      message: 'Could not parse your resume file',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * POST /analyze-jd
 * Processes job description and extracts key information
 */
app.post('/analyze-jd', 
  body('jobDescription').isLength({ min: 20 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        logger.warn('Invalid job description', { errors: errors.array() });
        return res.status(400).json({ 
          error: 'Invalid job description',
          message: 'Job description must be at least 20 characters long',
          errors: errors.array()
        });
      }

      const { jobDescription } = req.body;
      const jdData = analyzeJobDescription(jdText);
      
      logger.info('Job description analyzed successfully');
      res.json({
        success: true,
        data: jdData
      });
    } catch (error) {
      logger.error('JD analysis error:', error);
      res.status(500).json({ 
        error: 'Error analyzing job description',
        message: 'Could not process the job description',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * POST /generate
 * Generates cover letter using Gemini API
 */
app.post('/generate', verifyPayment, async (req, res) => {
  try {
    const { resumeData, jobDescription, tone = 'formal' } = req.body;

    // Validate input
    if (!resumeData || !jobDescription) {
      logger.warn('Missing data for generation');
      return res.status(400).json({ 
        error: 'Missing data',
        message: 'Both resume data and job description are required'
      });
    }

    if (!resumeData.name || !resumeData.email) {
      logger.warn('Incomplete resume data');
      return res.status(400).json({ 
        error: 'Incomplete resume',
        message: 'Resume must include name and email'
      });
    }

    if (!GEMINI_API_KEY) {
      logger.error('Gemini API key not configured');
      return res.status(500).json({ 
        error: 'Configuration error',
        message: 'Service is currently unavailable'
      });
    }

    // Analyze job description first
    const jdData = analyzeJobDescription(jobDescription);

    // Generate cover letter using Gemini API
    const coverLetter = await generateCoverLetter(resumeData, jdData, tone);
    
    logger.info('Cover letter generated successfully', { email: resumeData.email });
    res.json({
      success: true,
      data: {
        coverLetter,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('Generation error:', error);
    
    let status = 500;
    let errorMessage = 'Error generating cover letter';
    let userMessage = 'Could not generate your cover letter';
    
    // Handle specific Gemini API errors
    if (error.response?.data?.error) {
      status = 400;
      errorMessage = `AI API Error: ${error.response.data.error.message}`;
      userMessage = 'There was an issue with the AI service';
    }
    
    res.status(status).json({ 
      error: errorMessage,
      message: userMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Helper Functions (remain exactly the same as in your original file)
function extractResumeData(text) {
  const lines = text.split('\n').filter(line => line.trim());
  let name = lines[0].trim();
  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
  const email = emailMatch ? emailMatch[0] : '';
  const phoneMatch = text.match(/(\+?\d{1,2}\s?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/);
  const phone = phoneMatch ? phoneMatch[0] : '';
  
  let skills = [];
  const skillsSection = text.match(/(skills|technical skills|key skills):?\s*([^]+?)(?=\n\w+:|$)/i);
  if (skillsSection) {
    skills = skillsSection[0].split('\n')
      .slice(1)
      .flatMap(line => line.split(/[,;•]+\s*/))
      .filter(skill => skill.trim() && skill.trim().length > 2)
      .map(skill => skill.trim());
  }
  
  let experience = [];
  const expSection = text.match(/(experience|work history|employment history):?\s*([^]+?)(?=\n\w+:|$)/i);
  if (expSection) {
    experience = expSection[0].split('\n')
      .slice(1)
      .filter(line => line.trim() && line.trim().length > 10)
      .map(line => line.trim());
  }
  
  let education = [];
  const eduSection = text.match(/(education|academic background|qualifications):?\s*([^]+?)(?=\n\w+:|$)/i);
  if (eduSection) {
    education = eduSection[0].split('\n')
      .slice(1)
      .filter(line => line.trim() && line.trim().length > 10)
      .map(line => line.trim());
  }
  
  return {
    name,
    email,
    phone,
    experience: experience.length ? experience : ['Various professional experiences'],
    education: education.length ? education : ['Relevant educational background'],
    skills: skills.length ? skills : ['Various professional skills']
  };
}

function analyzeJobDescription(jdText) {
  const companyMatch = jdText.match(/at\s+([A-Z][a-zA-Z0-9\s-]*)/i) || 
                       jdText.match(/company:\s*([^\n]+)/i) || 
                       jdText.match(/about\s+([A-Z][a-zA-Z0-9\s-]*)/i);
  
  const roleMatch = jdText.match(/position:\s*([^\n]+)/i) || 
                   jdText.match(/role:\s*([^\n]+)/i) || 
                   jdText.match(/looking for a\s+([^\n]+)/i) || 
                   jdText.match(/seeking a\s+([^\n]+)/i);
  
  const requirements = [];
  if (jdText.includes('experience')) requirements.push('X years of experience');
  if (jdText.includes('degree')) requirements.push('Bachelor\'s degree or higher');
  if (jdText.includes('communication')) requirements.push('Strong communication skills');
  if (jdText.includes('team')) requirements.push('Team player');
  if (jdText.includes('leadership')) requirements.push('Leadership abilities');
  
  const skillKeywords = [
    'JavaScript', 'Python', 'Java', 'C++', 'React', 'Angular', 
    'Node.js', 'SQL', 'NoSQL', 'AWS', 'Azure', 'Docker', 
    'Kubernetes', 'CI/CD', 'Agile', 'Scrum', 'Figma', 
    'Photoshop', 'Illustrator', 'SEO', 'SEM', 'Google Analytics',
    'Email Marketing', 'Social Media', 'Content Creation'
  ];
  
  skillKeywords.forEach(skill => {
    if (jdText.includes(skill)) requirements.push(skill);
  });
  
  return {
    company: companyMatch ? companyMatch[1].trim() : 'the company',
    role: roleMatch ? roleMatch[1].trim() : 'the position',
    requirements: requirements.length ? requirements : ['Various skills and experiences']
  };
}

async function generateCoverLetter(resumeData, jdData, tone) {
  const prompt = `
    Write a professional cover letter for ${resumeData.name} applying for the ${jdData.role} position at ${jdData.company}.
    
    Resume Information:
    - Name: ${resumeData.name}
    - Email: ${resumeData.email}
    - Phone: ${resumeData.phone || 'Not specified'}
    - Experience: ${resumeData.experience.join('; ')}
    - Education: ${resumeData.education.join('; ')}
    - Skills: ${resumeData.skills.join(', ')}
    
    Job Requirements:
    ${jdData.requirements.join('\n- ')}
    
    Tone: ${tone}
    
    Requirements:
    - Keep it between 250-400 words
    - Address the hiring manager professionally
    - Highlight 2-3 most relevant skills from the resume
    - Mention the company name 2-3 times
    - Include 1-2 specific achievements
    - Use a ${tone} tone
    - Format with proper paragraphs
    
    Output only the cover letter content (no headings or explanations).
  `;

  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [{ text: prompt }]
      }]
    },
    {
      headers: { 'Content-Type': 'application/json' }
    }
  );

  if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.data.candidates[0].content.parts[0].text;
  }

  throw new Error('Unexpected response format from Gemini API');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info('API endpoints:');
  logger.info('- POST /upload - For resume upload and parsing');
  logger.info('- POST /analyze-jd - For job description analysis');
  logger.info('- POST /generate - For cover letter generation');
});

module.exports = app;