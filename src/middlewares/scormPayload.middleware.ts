import { NextFunction, Request, Response } from "express";
const LZString = require("lz-string");

function normalizeString(value: unknown) {
  return String(value ?? "").trim();
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function extractFirstJsonValue(value: string) {
  const normalizedValue = normalizeString(value);
  if (!normalizedValue) {
    return null;
  }

  const startIndex = normalizedValue.search(/[\[{]/);
  if (startIndex < 0) {
    return null;
  }

  const openingChar = normalizedValue[startIndex];
  const closingChar = openingChar === "{" ? "}" : "]";
  const stack: string[] = [];
  let isInsideString = false;
  let isEscaped = false;

  for (let index = startIndex; index < normalizedValue.length; index += 1) {
    const char = normalizedValue[index];

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === "\\") {
        isEscaped = true;
      } else if (char === "\"") {
        isInsideString = false;
      }
      continue;
    }

    if (char === "\"") {
      isInsideString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }

    if (char === "}" || char === "]") {
      if (stack.length === 0 || stack[stack.length - 1] !== char) {
        return null;
      }

      stack.pop();
      if (stack.length === 0 && char === closingChar) {
        return normalizedValue.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function parseSuspendDataCandidate(value: string) {
  const strictParsed = safeJsonParse(value);
  if (strictParsed !== null) {
    return strictParsed;
  }

  const extractedJson = extractFirstJsonValue(value);
  return extractedJson ? safeJsonParse(extractedJson) : null;
}

function buildSuspendDataCandidates(suspendData: string) {
  const normalizedSuspendData = normalizeString(suspendData);
  if (!normalizedSuspendData) {
    return [];
  }

  return [
    normalizedSuspendData,
    (() => {
      try {
        return decodeURIComponent(normalizedSuspendData);
      } catch (error) {
        return "";
      }
    })(),
    LZString.decompressFromEncodedURIComponent(normalizedSuspendData) || "",
    LZString.decompressFromBase64(normalizedSuspendData) || "",
    LZString.decompress(normalizedSuspendData) || "",
  ].filter(Boolean);
}

export const decodeScormPayloadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return next();
    }

    const { suspend_data } = req.body;

    if (!suspend_data || typeof suspend_data !== "string" || suspend_data.trim() === "") {
      return next();
    }

    const candidates = buildSuspendDataCandidates(suspend_data);
    for (const candidate of candidates) {
      const parsedPayload = parseSuspendDataCandidate(candidate);
      if (parsedPayload !== null) {
        req.body.decoded_suspend_data = parsedPayload;
        return next();
      }
    }

    console.warn("Unable to parse SCORM suspend_data as JSON; continuing without decoded_suspend_data.");
    req.body.decoded_suspend_data = null;
  } catch (err) {
    console.warn("Error in decodeScormPayloadMiddleware:", err);
    if (req.body) {
      req.body.decoded_suspend_data = null;
    }
  }

  next();
};
