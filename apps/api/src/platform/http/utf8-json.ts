import { HttpException } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Logger } from 'pino';

import { sendFailure } from './all-exceptions.filter.js';

/** A parameter of a media type, such as `charset=utf-8`: name, then a token or a quoted string. */
const PARAMETER = /;\s*([^\s=;]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g;

function parametersOf(contentType: string): { readonly name: string; readonly value: string }[] {
  return [...contentType.matchAll(PARAMETER)].map((match) => ({
    name: (match[1] ?? '').toLowerCase(),
    value: (match[2] ?? '')
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .toLowerCase(),
  }));
}

function isJson(contentType: string): boolean {
  return /^\s*application\/json\s*(;|$)/i.test(contentType);
}

/**
 * Whether a JSON content type promises UTF-8: no charset at all (JSON is UTF-8), or exactly one that says so.
 * The body parser accepts any charset that begins `utf-`, and the decoder behind it reads `utf-7`, `utf-16` and
 * `utf-32` too, so a body in those would reach a handler decoded while anything in front of the application that
 * inspected its bytes as UTF-8 (a gateway, a filter) saw different text.
 */
export function promisesUtf8(contentType: string): boolean {
  const charsets = parametersOf(contentType).filter((parameter) => parameter.name === 'charset');
  return charsets.length === 0 || (charsets.length === 1 && charsets[0]?.value === 'utf-8');
}

/** Refuses a JSON request body that is not declared as UTF-8, before the body is read. */
export function requireUtf8Json(logger: Logger): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const contentType = request.headers['content-type'];
    if (typeof contentType === 'string' && isJson(contentType) && !promisesUtf8(contentType)) {
      sendFailure(response, new HttpException('Unsupported Media Type', 415), logger);
      return;
    }
    next();
  };
}
