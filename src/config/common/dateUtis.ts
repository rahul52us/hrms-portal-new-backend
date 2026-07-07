/**
 * Convert a UTC date string or object to the desired time zone and format it.
 * @param {string | Date} utcDate - The date in UTC format.
 * @param {string} [timeZone='Asia/Kolkata'] - The IANA time zone name (default is 'Asia/Kolkata' for IST).
 * @returns {string} The corresponding date in the specified time zone as a formatted string.
 */
export const convertUTCtoTimeZone = (utcDate: string | Date, timeZone: string = 'Asia/Kolkata'): string => {
    const date = new Date(utcDate);

    // Get the local date in the specified time zone
    const localDate = new Date(date.toLocaleString('en-US', { timeZone }));

    // Extracting components to format
    const month = String(localDate.getUTCMonth() + 1).padStart(2, '0'); // Month is 0-indexed
    const day = String(localDate.getUTCDate()).padStart(2, '0');
    const year = localDate.getUTCFullYear();
    const hours = String(localDate.getUTCHours()).padStart(2, '0');
    const minutes = String(localDate.getUTCMinutes()).padStart(2, '0');
    const seconds = String(localDate.getUTCSeconds()).padStart(2, '0');

    // Return formatted date as per your requirement
    return `${month}/${day}/${year}, ${hours}:${minutes}:${seconds}`;
};

/**
 * Convert a time zone date string or object to UTC.
 * @param {string | Date} localDate - The date in the local time zone format.
 * @param {string} [timeZone='Asia/Kolkata'] - The IANA time zone name (default is 'Asia/Kolkata' for IST).
 * @returns {Date} The corresponding UTC date.
 */
export const convertTimeZoneToUTC = (localDate: string | Date, timeZone: string = 'Asia/Kolkata'): Date => {
    const date = new Date(localDate);

    // Get the offset in minutes and convert it to milliseconds
    const timeZoneOffset = date.getTimezoneOffset() * 60000;

    // Adjust the date for the specified time zone
    const timeZoneDate = new Date(date.getTime() + timeZoneOffset);

    // Return the UTC date
    return new Date(timeZoneDate.toLocaleString('en-US', { timeZone: 'UTC' }));
};

/**
 * Get the current date in UTC and the desired time zone.
 * @param {string} [timeZone='Asia/Kolkata'] - The IANA time zone name (default is 'Asia/Kolkata' for IST).
 * @returns {object} - Object containing both the current UTC and local time zone dates.
 */
export const getCurrentDatesInTimeZone = (timeZone: string = 'Asia/Kolkata') => {
    const nowUTC = new Date();
    const localDate = new Date(new Date().toLocaleString('en-US', { timeZone }));

    return {
      utc: nowUTC,
      local: convertUTCtoTimeZone(localDate),
      localISO: localDate.toISOString(), // Return the local time zone in ISO format if needed
    };
};

// Example of using the function to get formatted local date
const startDate = '2024-10-21T18:30:00.000Z'; // Original UTC date
const endDate = '2024-10-23T18:30:00.000Z';   // Original UTC date

// Convert UTC to IST for start and end dates
const startIST = convertUTCtoTimeZone(startDate);
const endIST = convertUTCtoTimeZone(endDate);

// Get the current date in IST in MongoDB format
const currentISTMongoDBFormat = getCurrentDatesInTimeZone().localISO;

console.log('startDate (original UTC):', startDate);
console.log('endDate (original UTC):', endDate);
console.log('startIST:', startIST); // Formatted start date
console.log('endIST:', endIST);     // Formatted end date
console.log('currentISTMongoDBFormat:', currentISTMongoDBFormat); // Current IST date in MongoDB format
