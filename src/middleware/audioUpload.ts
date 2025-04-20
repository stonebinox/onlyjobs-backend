import multer from "multer";

// Use memory storage since you'll stream to OpenAI
const storage = multer.memoryStorage();

// Accept only audio MIME types
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedTypes = [
    "audio/mpeg",
    "audio/mp3",
    "audio/wav",
    "audio/webm",
    "audio/mp4",
    "audio/x-m4a",
  ];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(null, false);

    return cb(new Error("Only audio files are allowed!"));
  }
};

const audioUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
});

export default audioUpload;
