/* eslint-disable @typescript-eslint/no-explicit-any */
import debug from "debug";
import * as log4js from "log4js";
export { Logger } from "log4js";
import * as fs from "fs";
const styles = {
  // styles
  bold: [1, 22],
  italic: [3, 23],
  underline: [4, 24],
  inverse: [7, 27],
  // grayscale
  white: [37, 39],
  grey: [90, 39],
  black: [90, 39],
  // colors
  blue: [34, 39],
  cyan: [36, 39],
  green: [32, 39],
  magenta: [35, 39],
  red: [91, 39],
  yellow: [33, 39],
};

function colorizeStart(style: keyof typeof styles = "white") {
  return style ? `\x1B[${styles[style][0]}m` : "";
}

function colorizeEnd(style: keyof typeof styles = "white") {
  return style ? `\x1B[${styles[style][1]}m` : "";
}

let isEnableLineNumber = process.env["DEBUG_LOGGING"] === "true" || process.env["DEBUG_LOGGING"] === "1";
isEnableLineNumber = true;

let LOG_PATTERN;
if (isEnableLineNumber) {
  LOG_PATTERN = `\u001b[1m%[%d{hh:mm:ss} [%c] %p:%]\u001b[0m ${colorizeStart("grey")}(%f{1}:%l)${colorizeEnd("grey")} %m`;
}
else {
  LOG_PATTERN = "\u001b[1m%[%d{hh:mm:ss} [%c] %p:%]\u001b[0m %m";
}

//               BOLD_MARK Date [Category] Level: LogMessage BOLD_MARK_END
log4js.configure({
  appenders: { out: { type: "stdout", layout: { type: "pattern", pattern: LOG_PATTERN  } } },
  categories: { default: { appenders: ["out"], level: "debug", enableCallStack: isEnableLineNumber } },
});

let globalLogLevel = "debug";
export const setGlobalLogLevel = (level: string) => {
  globalLogLevel = level;
};

export const createLogger = (loggerName: string) => {
  const logger = log4js.getLogger(loggerName);
  logger.level = globalLogLevel;
  return logger;
};

export const createDebug = (namespace: string) => {
  const debugFunc = debug(`sigma16z:${namespace}`);
  // Open the FIFO for writing
  const fifoPath = `/tmp/debug_pipe_${namespace}`;
  const fifoStream = fs.createWriteStream(fifoPath);
  debugFunc.log = function (...args) {
    const message = args.join(" ") + "\n";
    fifoStream.write(message);
  };
  return debugFunc;
};