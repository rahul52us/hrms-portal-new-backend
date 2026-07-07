// // Import the Google Cloud Vision API client library
// const vision = require('@google-cloud/vision');
// const path = require('path');

// // Set up the Google Cloud Vision client
// const client = new vision.ImageAnnotatorClient({
//   keyFilename: path.join(__dirname, 'credentialData.json'), // Path to your JSON key file
// });

// // Function to extract text from an image
// async function extractTextFromImage() {
//   try {
//     // Path to your image file
//     const imagePath = path.join(__dirname, 'images.png');

//     // Call the Vision API to perform OCR
//     const [result] = await client.textDetection(imagePath);

//     // Extract and display the text
//     const detections = result.textAnnotations;
//     if (detections.length > 0) {
//       console.log('Extracted Text:');
//       console.log(detections[0].description); // Full text in the image
//     } else {
//       console.log('No text detected in the image.');
//     }
//   } catch (error) {
//     console.error('Error during text detection:', error);
//   }
// }

// // Call the function
// extractTextFromImage();
