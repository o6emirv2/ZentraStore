"use strict";
module.exports = async function* reporter(events) {
  for await (const event of events) {
    if (["test:pass", "test:fail", "test:summary"].includes(event.type))
      yield (
        JSON.stringify({ type: event.type, data: event.data }, (_key, value) =>
          value instanceof Error
            ? {
                name: value.name,
                code: value.code,
                message: value.message,
                stack: value.stack,
                cause: value.cause,
              }
            : value,
        ) + "\n"
      );
  }
};
