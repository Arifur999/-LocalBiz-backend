import { NextFunction, Request, Response } from "express";
import status from "http-status";
import multer from "multer";
import z from "zod";
import { env } from "../../config/env.js";
import { Prisma } from "../../generated/prisma/client.js";
import AppError from "../errorHelpers/AppError.js";
import {
    handlePrismaClientInitializationError,
    handlePrismaClientKnownRequestError,
    handlePrismaClientRustPanicError,
    handlePrismaClientUnknownError,
    handlePrismaClientValidationError,
} from "../errorHelpers/handlePrismaErrors.js";
import { handleZodError } from "../errorHelpers/handleZodError.js";
import { IError, IErrorResponse } from "../interfaces/error.interfaces.js";

// Expected auth rejections (not-logged-in visitors hitting /me, expired
// tokens) are routine - log them as one line instead of a full stack trace.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isExpectedAuthError = (err: any) =>
    err instanceof AppError && (err.statusCode === status.UNAUTHORIZED || err.statusCode === status.FORBIDDEN);

const isProduction = env.NODE_ENV === "production";

/** An http-errors style 4xx whose message is safe to show (`expose`). */
const isClientHttpError = (err: Error): err is Error & { status: number } => {
    const e = err as Error & { status?: unknown; expose?: unknown };
    return typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.expose === true;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
export const globalErrorHandler = async (err: any, req: Request, res: Response, next: NextFunction) => {
    if (env.NODE_ENV === "development") {
        if (isExpectedAuthError(err)) {
            console.log(`[auth] ${req.method} ${req.originalUrl} -> ${err.statusCode}: ${err.message}`);
        } else {
            console.log("Error from Global Error Handler:", err);
        }
    }

    let errorSource: IError[] = [];
    let statusCode: number = status.INTERNAL_SERVER_ERROR;
    let message = "Internal Server Error";
    let stack: string | undefined = undefined;

    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        const simplifiedError = handlePrismaClientKnownRequestError(err);
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientUnknownRequestError) {
        const simplifiedError = handlePrismaClientUnknownError(err);
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientValidationError) {
        const simplifiedError = handlePrismaClientValidationError();
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientInitializationError) {
        const simplifiedError = handlePrismaClientInitializationError();
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof Prisma.PrismaClientRustPanicError) {
        const simplifiedError = handlePrismaClientRustPanicError();
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof z.ZodError) {
        const simplifiedError = handleZodError(err);
        statusCode = simplifiedError.statusCode;
        message = simplifiedError.message;
        errorSource = [...simplifiedError.errorSource];
        stack = err.stack;
    } else if (err instanceof AppError) {
        statusCode = err.statusCode;
        message = err.message;
        stack = err.stack;
        errorSource = [{ path: "", message: err.message }];
    } else if (err instanceof multer.MulterError) {
        // File too large, too many files, unexpected field: the caller's mistake.
        statusCode = status.BAD_REQUEST;
        message = err.message;
        stack = err.stack;
        errorSource = [{ path: err.field ?? "", message: err.message }];
    } else if (err instanceof Error && isClientHttpError(err)) {
        // body-parser and friends throw http-errors with a 4xx status and a
        // message written for the client (malformed JSON, body too large).
        statusCode = err.status;
        message = err.message;
        stack = err.stack;
        errorSource = [{ path: "", message: err.message }];
    } else if (err instanceof Error) {
        statusCode = status.INTERNAL_SERVER_ERROR;
        // An unexpected error's own message can carry internals (SQL, file
        // paths, upstream responses), so production answers generically and
        // keeps the detail for the server log.
        message = isProduction ? "Internal Server Error" : err.message;
        stack = err.stack;
        errorSource = [{ path: "", message }];
    }

    // Production printed nothing at all, so a 500 left no trace anywhere.
    if (isProduction && statusCode >= 500) {
        console.error(`[error] ${req.method} ${req.originalUrl} -> ${statusCode}:`, err);
    }

    const errorResponse: IErrorResponse = {
        success: false,
        message,
        errorSource,
        error: env.NODE_ENV === "development" ? err : undefined,
        stack: env.NODE_ENV === "development" ? stack : undefined,
    };

    res.status(statusCode).json(errorResponse);
};
