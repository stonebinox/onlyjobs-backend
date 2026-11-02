import multer from "multer";

export const UNSUPPORTED_TYPE_MESSAGE = "Only PDF and Word documents are allowed";

// Configure multer for memory storage
const storage = multer.memoryStorage();

// Accept every file type here: multer's memory storage gives the filter no file
// buffer, so it cannot sniff content. The magic-byte check in parseUserCV is the
// authoritative gate. Calls cb exactly once.
const fileFilter = (
  req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  cb(null, true);
};

// Create the multer instance with configuration
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

export default upload;
