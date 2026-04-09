import { IUser } from "../models/User";

declare global {
  namespace Express {
    interface Request {
      file?: Multer.File;
      files?: {
        [fieldname: string]: Multer.File[];
      };
      user?: IUser;
    }
  }
}
