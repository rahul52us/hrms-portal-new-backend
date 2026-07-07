import mongoose from "mongoose";

let cached = (global as any).mongoose || { conn: null, promise: null };

const connectToDatabase = async () => {
  if (cached.conn) {
    return cached.conn;
  }

  const uri = process.env.MONGODB_URI as string;

  if (!uri) {
    throw new Error("MONGODB_URI not defined");
  }

  try {
    if (!cached.promise) {
      console.log("Connecting to MongoDB...");
      cached.promise = mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        bufferCommands: false,
      });
    }

    const conn = await cached.promise;
    cached.conn = conn;
    (global as any).mongoose = cached;

    console.log("MongoDB connected");
    return conn;
  } catch (error: any) {
    cached.promise = null;
    console.error("MongoDB error:", error.message);
    throw error;
  }
};

export default connectToDatabase;
