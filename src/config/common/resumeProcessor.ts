import { Request, Response } from 'express';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as path from 'path';

// Define the type for extracted sections and information
interface ResumeSections {
    personalInfo: string;
    education: string;
    experience: string;
    skills: string;
}

interface ExtractedInfo {
    name: string;
    degree: string;
    position: string;
    skills: string;
};

// Extract text from PDF buffer using pdf-parse
export const extractTextFromPDFBuffer = async (fileBuffer: Buffer): Promise<string> => {
    try {
        const data = await pdfParse(fileBuffer);
        return data.text;
    } catch (error: any) {
        console.error('Error extracting text from PDF buffer:', error.message);
        console.error('Stack trace:', error.stack);
        throw error;
    }
};

// Extract text from DOCX buffer
export const extractTextFromDOCXBuffer = async (fileBuffer: Buffer): Promise<string> => {
    try {
        const data = await mammoth.extractRawText({ buffer: fileBuffer });
        return data.value;
    } catch (error: any) {
        console.error('Error extracting text from DOCX buffer:', error.message);
        console.error('Stack trace:', error.stack);
        throw error;
    }
};

// Detect file type and extract text from buffer
export const detectAndExtractTextFromBuffer = async (fileBuffer: Buffer, fileType: string): Promise<string> => {
    try {
        if (fileType === '.pdf') {
            return extractTextFromPDFBuffer(fileBuffer);
        } else if (fileType === '.docx') {
            return extractTextFromDOCXBuffer(fileBuffer);
        } else {
            throw new Error('Unsupported file type');
        }
    } catch (error: any) {
        console.error('Error detecting and extracting text from buffer:', error.message);
        console.error('Stack trace:', error.stack);
        throw error;
    }
};

// Segment text into different sections
export const segmentResume = (text: string): ResumeSections => {
    // Simple text segmentation logic; customize this as needed
    const sections: ResumeSections = {
        personalInfo: text.match(/Personal Information[\s\S]*?Education/i)?.[0] || '',
        education: text.match(/Education[\s\S]*?Experience/i)?.[0] || '',
        experience: text.match(/Experience[\s\S]*?Skills/i)?.[0] || '',
        skills: text.match(/Skills[\s\S]*$/i)?.[0] || '',
    };

    return sections;
};

// Extract dynamic information from segmented sections
export const extractDynamicInfo = (sections: ResumeSections): ExtractedInfo => {
    const personalInfoMatch = sections.personalInfo.match(/Name:\s*(.*)/i);
    const educationMatch = sections.education.match(/Degree:\s*(.*)/i);
    const experienceMatch = sections.experience.match(/Position:\s*(.*)/i);
    const skillsMatch = sections.skills.match(/Skills:\s*(.*)/i);

    return {
        name: personalInfoMatch ? personalInfoMatch[1] : 'Unknown',
        degree: educationMatch ? educationMatch[1] : 'Unknown',
        position: experienceMatch ? experienceMatch[1] : 'Unknown',
        skills: skillsMatch ? skillsMatch[1] : 'Unknown',
    };
};

// Process resume from a buffer
export const processResumeFromBuffer = async (fileBuffer: Buffer, fileType: string): Promise<ExtractedInfo | null> => {
    try {
        const text = await detectAndExtractTextFromBuffer(fileBuffer, fileType);
        const sections = segmentResume(text);
        const extractedInfo = extractDynamicInfo(sections);
        return extractedInfo;
    } catch (error: any) {
        console.error('Error processing resume:', error.message);
        console.error('Stack trace:', error.stack);
        return null;
    }
};

// Handle resume processing request
export const processResumeData = async (req: Request, res: Response): Promise<Response> => {
    const { base64Data, fileName } = req.body as { base64Data: string; fileName: string };

    if (!base64Data || !fileName) {
        return res.status(400).json({ error: 'Missing base64 data or file name' });
    }

    try {
        const fileBuffer = Buffer.from(base64Data, 'base64');
        const fileType = path.extname(fileName).toLowerCase();
        const extractedInfo = await processResumeFromBuffer(fileBuffer, fileType);

        if (extractedInfo) {
            return res.json({ extractedInfo });
        } else {
            return res.status(500).json({ error: 'Failed to process resume' });
        }
    } catch (error: any) {
        console.error('Error processing resume data:', error.message);
        console.error('Stack trace:', error.stack);
        return res.status(500).json({ error: 'An error occurred while processing the resume' });
    }
};
