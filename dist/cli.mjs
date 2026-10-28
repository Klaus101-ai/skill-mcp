#!/usr/bin/env node

// cli/main.mjs
import fs3 from "node:fs";
import os3 from "node:os";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// node_modules/jsonc-parser/lib/esm/impl/scanner.js
function createScanner(text, ignoreTrivia = false) {
  const len = text.length;
  let pos = 0, value = "", tokenOffset = 0, token = 16, lineNumber = 0, lineStartOffset = 0, tokenLineStartOffset = 0, prevTokenLineStartOffset = 0, scanError = 0;
  function scanHexDigits(count, exact) {
    let digits = 0;
    let value2 = 0;
    while (digits < count || !exact) {
      let ch = text.charCodeAt(pos);
      if (ch >= 48 && ch <= 57) {
        value2 = value2 * 16 + ch - 48;
      } else if (ch >= 65 && ch <= 70) {
        value2 = value2 * 16 + ch - 65 + 10;
      } else if (ch >= 97 && ch <= 102) {
        value2 = value2 * 16 + ch - 97 + 10;
      } else {
        break;
      }
      pos++;
      digits++;
    }
    if (digits < count) {
      value2 = -1;
    }
    return value2;
  }
  function setPosition(newPosition) {
    pos = newPosition;
    value = "";
    tokenOffset = 0;
    token = 16;
    scanError = 0;
  }
  function scanNumber() {
    let start = pos;
    if (text.charCodeAt(pos) === 48) {
      pos++;
    } else {
      pos++;
      while (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
      }
    }
    if (pos < text.length && text.charCodeAt(pos) === 46) {
      pos++;
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
      } else {
        scanError = 3;
        return text.substring(start, pos);
      }
    }
    let end = pos;
    if (pos < text.length && (text.charCodeAt(pos) === 69 || text.charCodeAt(pos) === 101)) {
      pos++;
      if (pos < text.length && text.charCodeAt(pos) === 43 || text.charCodeAt(pos) === 45) {
        pos++;
      }
      if (pos < text.length && isDigit(text.charCodeAt(pos))) {
        pos++;
        while (pos < text.length && isDigit(text.charCodeAt(pos))) {
          pos++;
        }
        end = pos;
      } else {
        scanError = 3;
      }
    }
    return text.substring(start, end);
  }
  function scanString() {
    let result = "", start = pos;
    while (true) {
      if (pos >= len) {
        result += text.substring(start, pos);
        scanError = 2;
        break;
      }
      const ch = text.charCodeAt(pos);
      if (ch === 34) {
        result += text.substring(start, pos);
        pos++;
        break;
      }
      if (ch === 92) {
        result += text.substring(start, pos);
        pos++;
        if (pos >= len) {
          scanError = 2;
          break;
        }
        const ch2 = text.charCodeAt(pos++);
        switch (ch2) {
          case 34:
            result += '"';
            break;
          case 92:
            result += "\\";
            break;
          case 47:
            result += "/";
            break;
          case 98:
            result += "\b";
            break;
          case 102:
            result += "\f";
            break;
          case 110:
            result += "\n";
            break;
          case 114:
            result += "\r";
            break;
          case 116:
            result += "	";
            break;
          case 117:
            const ch3 = scanHexDigits(4, true);
            if (ch3 >= 0) {
              result += String.fromCharCode(ch3);
            } else {
              scanError = 4;
            }
            break;
          default:
            scanError = 5;
        }
        start = pos;
        continue;
      }
      if (ch >= 0 && ch <= 31) {
        if (isLineBreak(ch)) {
          result += text.substring(start, pos);
          scanError = 2;
          break;
        } else {
          scanError = 6;
        }
      }
      pos++;
    }
    return result;
  }
  function scanNext() {
    value = "";
    scanError = 0;
    tokenOffset = pos;
    lineStartOffset = lineNumber;
    prevTokenLineStartOffset = tokenLineStartOffset;
    if (pos >= len) {
      tokenOffset = len;
      return token = 17;
    }
    let code = text.charCodeAt(pos);
    if (isWhiteSpace(code)) {
      do {
        pos++;
        value += String.fromCharCode(code);
        code = text.charCodeAt(pos);
      } while (isWhiteSpace(code));
      return token = 15;
    }
    if (isLineBreak(code)) {
      pos++;
      value += String.fromCharCode(code);
      if (code === 13 && text.charCodeAt(pos) === 10) {
        pos++;
        value += "\n";
      }
      lineNumber++;
      tokenLineStartOffset = pos;
      return token = 14;
    }
    switch (code) {
      // tokens: []{}:,
      case 123:
        pos++;
        return token = 1;
      case 125:
        pos++;
        return token = 2;
      case 91:
        pos++;
        return token = 3;
      case 93:
        pos++;
        return token = 4;
      case 58:
        pos++;
        return token = 6;
      case 44:
        pos++;
        return token = 5;
      // strings
      case 34:
        pos++;
        value = scanString();
        return token = 10;
      // comments
      case 47:
        const start = pos - 1;
        if (text.charCodeAt(pos + 1) === 47) {
          pos += 2;
          while (pos < len) {
            if (isLineBreak(text.charCodeAt(pos))) {
              break;
            }
            pos++;
          }
          value = text.substring(start, pos);
          return token = 12;
        }
        if (text.charCodeAt(pos + 1) === 42) {
          pos += 2;
          const safeLength = len - 1;
          let commentClosed = false;
          while (pos < safeLength) {
            const ch = text.charCodeAt(pos);
            if (ch === 42 && text.charCodeAt(pos + 1) === 47) {
              pos += 2;
              commentClosed = true;
              break;
            }
            pos++;
            if (isLineBreak(ch)) {
              if (ch === 13 && text.charCodeAt(pos) === 10) {
                pos++;
              }
              lineNumber++;
              tokenLineStartOffset = pos;
            }
          }
          if (!commentClosed) {
            pos++;
            scanError = 1;
          }
          value = text.substring(start, pos);
          return token = 13;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
      // numbers
      case 45:
        value += String.fromCharCode(code);
        pos++;
        if (pos === len || !isDigit(text.charCodeAt(pos))) {
          return token = 16;
        }
      // found a minus, followed by a number so
      // we fall through to proceed with scanning
      // numbers
      case 48:
      case 49:
      case 50:
      case 51:
      case 52:
      case 53:
      case 54:
      case 55:
      case 56:
      case 57:
        value += scanNumber();
        return token = 11;
      // literals and unknown symbols
      default:
        while (pos < len && isUnknownContentCharacter(code)) {
          pos++;
          code = text.charCodeAt(pos);
        }
        if (tokenOffset !== pos) {
          value = text.substring(tokenOffset, pos);
          switch (value) {
            case "true":
              return token = 8;
            case "false":
              return token = 9;
            case "null":
              return token = 7;
          }
          return token = 16;
        }
        value += String.fromCharCode(code);
        pos++;
        return token = 16;
    }
  }
  function isUnknownContentCharacter(code) {
    if (isWhiteSpace(code) || isLineBreak(code)) {
      return false;
    }
    switch (code) {
      case 125:
      case 93:
      case 123:
      case 91:
      case 34:
      case 58:
      case 44:
      case 47:
        return false;
    }
    return true;
  }
  function scanNextNonTrivia() {
    let result;
    do {
      result = scanNext();
    } while (result >= 12 && result <= 15);
    return result;
  }
  return {
    setPosition,
    getPosition: () => pos,
    scan: ignoreTrivia ? scanNextNonTrivia : scanNext,
    getToken: () => token,
    getTokenValue: () => value,
    getTokenOffset: () => tokenOffset,
    getTokenLength: () => pos - tokenOffset,
    getTokenStartLine: () => lineStartOffset,
    getTokenStartCharacter: () => tokenOffset - prevTokenLineStartOffset,
    getTokenError: () => scanError
  };
}
function isWhiteSpace(ch) {
  return ch === 32 || ch === 9;
}
function isLineBreak(ch) {
  return ch === 10 || ch === 13;
}
function isDigit(ch) {
  return ch >= 48 && ch <= 57;
}
var CharacterCodes;
(function(CharacterCodes2) {
  CharacterCodes2[CharacterCodes2["lineFeed"] = 10] = "lineFeed";
  CharacterCodes2[CharacterCodes2["carriageReturn"] = 13] = "carriageReturn";
  CharacterCodes2[CharacterCodes2["space"] = 32] = "space";
  CharacterCodes2[CharacterCodes2["_0"] = 48] = "_0";
  CharacterCodes2[CharacterCodes2["_1"] = 49] = "_1";
  CharacterCodes2[CharacterCodes2["_2"] = 50] = "_2";
  CharacterCodes2[CharacterCodes2["_3"] = 51] = "_3";
  CharacterCodes2[CharacterCodes2["_4"] = 52] = "_4";
  CharacterCodes2[CharacterCodes2["_5"] = 53] = "_5";
  CharacterCodes2[CharacterCodes2["_6"] = 54] = "_6";
  CharacterCodes2[CharacterCodes2["_7"] = 55] = "_7";
  CharacterCodes2[CharacterCodes2["_8"] = 56] = "_8";
  CharacterCodes2[CharacterCodes2["_9"] = 57] = "_9";
  CharacterCodes2[CharacterCodes2["a"] = 97] = "a";
  CharacterCodes2[CharacterCodes2["b"] = 98] = "b";
  CharacterCodes2[CharacterCodes2["c"] = 99] = "c";
  CharacterCodes2[CharacterCodes2["d"] = 100] = "d";
  CharacterCodes2[CharacterCodes2["e"] = 101] = "e";
  CharacterCodes2[CharacterCodes2["f"] = 102] = "f";
  CharacterCodes2[CharacterCodes2["g"] = 103] = "g";
  CharacterCodes2[CharacterCodes2["h"] = 104] = "h";
  CharacterCodes2[CharacterCodes2["i"] = 105] = "i";
  CharacterCodes2[CharacterCodes2["j"] = 106] = "j";
  CharacterCodes2[CharacterCodes2["k"] = 107] = "k";
  CharacterCodes2[CharacterCodes2["l"] = 108] = "l";
  CharacterCodes2[CharacterCodes2["m"] = 109] = "m";
  CharacterCodes2[CharacterCodes2["n"] = 110] = "n";
  CharacterCodes2[CharacterCodes2["o"] = 111] = "o";
  CharacterCodes2[CharacterCodes2["p"] = 112] = "p";
  CharacterCodes2[CharacterCodes2["q"] = 113] = "q";
  CharacterCodes2[CharacterCodes2["r"] = 114] = "r";
  CharacterCodes2[CharacterCodes2["s"] = 115] = "s";
  CharacterCodes2[CharacterCodes2["t"] = 116] = "t";
  CharacterCodes2[CharacterCodes2["u"] = 117] = "u";
  CharacterCodes2[CharacterCodes2["v"] = 118] = "v";
  CharacterCodes2[CharacterCodes2["w"] = 119] = "w";
  CharacterCodes2[CharacterCodes2["x"] = 120] = "x";
  CharacterCodes2[CharacterCodes2["y"] = 121] = "y";
  CharacterCodes2[CharacterCodes2["z"] = 122] = "z";
  CharacterCodes2[CharacterCodes2["A"] = 65] = "A";
  CharacterCodes2[CharacterCodes2["B"] = 66] = "B";
  CharacterCodes2[CharacterCodes2["C"] = 67] = "C";
  CharacterCodes2[CharacterCodes2["D"] = 68] = "D";
  CharacterCodes2[CharacterCodes2["E"] = 69] = "E";
  CharacterCodes2[CharacterCodes2["F"] = 70] = "F";
  CharacterCodes2[CharacterCodes2["G"] = 71] = "G";
  CharacterCodes2[CharacterCodes2["H"] = 72] = "H";
  CharacterCodes2[CharacterCodes2["I"] = 73] = "I";
  CharacterCodes2[CharacterCodes2["J"] = 74] = "J";
  CharacterCodes2[CharacterCodes2["K"] = 75] = "K";
  CharacterCodes2[CharacterCodes2["L"] = 76] = "L";
  CharacterCodes2[CharacterCodes2["M"] = 77] = "M";
  CharacterCodes2[CharacterCodes2["N"] = 78] = "N";
  CharacterCodes2[CharacterCodes2["O"] = 79] = "O";
  CharacterCodes2[CharacterCodes2["P"] = 80] = "P";
  CharacterCodes2[CharacterCodes2["Q"] = 81] = "Q";
  CharacterCodes2[CharacterCodes2["R"] = 82] = "R";
  CharacterCodes2[CharacterCodes2["S"] = 83] = "S";
  CharacterCodes2[CharacterCodes2["T"] = 84] = "T";
  CharacterCodes2[CharacterCodes2["U"] = 85] = "U";
  CharacterCodes2[CharacterCodes2["V"] = 86] = "V";
  CharacterCodes2[CharacterCodes2["W"] = 87] = "W";
  CharacterCodes2[CharacterCodes2["X"] = 88] = "X";
  CharacterCodes2[CharacterCodes2["Y"] = 89] = "Y";
  CharacterCodes2[CharacterCodes2["Z"] = 90] = "Z";
  CharacterCodes2[CharacterCodes2["asterisk"] = 42] = "asterisk";
  CharacterCodes2[CharacterCodes2["backslash"] = 92] = "backslash";
  CharacterCodes2[CharacterCodes2["closeBrace"] = 125] = "closeBrace";
  CharacterCodes2[CharacterCodes2["closeBracket"] = 93] = "closeBracket";
  CharacterCodes2[CharacterCodes2["colon"] = 58] = "colon";
  CharacterCodes2[CharacterCodes2["comma"] = 44] = "comma";
  CharacterCodes2[CharacterCodes2["dot"] = 46] = "dot";
  CharacterCodes2[CharacterCodes2["doubleQuote"] = 34] = "doubleQuote";
  CharacterCodes2[CharacterCodes2["minus"] = 45] = "minus";
  CharacterCodes2[CharacterCodes2["openBrace"] = 123] = "openBrace";
  CharacterCodes2[CharacterCodes2["openBracket"] = 91] = "openBracket";
  CharacterCodes2[CharacterCodes2["plus"] = 43] = "plus";
  CharacterCodes2[CharacterCodes2["slash"] = 47] = "slash";
  CharacterCodes2[CharacterCodes2["formFeed"] = 12] = "formFeed";
  CharacterCodes2[CharacterCodes2["tab"] = 9] = "tab";
})(CharacterCodes || (CharacterCodes = {}));

// node_modules/jsonc-parser/lib/esm/impl/string-intern.js
var cachedSpaces = new Array(20).fill(0).map((_, index) => {
  return " ".repeat(index);
});
var maxCachedValues = 200;
var cachedBreakLinesWithSpaces = {
  " ": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + " ".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + " ".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + " ".repeat(index);
    })
  },
  "	": {
    "\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\n" + "	".repeat(index);
    }),
    "\r": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r" + "	".repeat(index);
    }),
    "\r\n": new Array(maxCachedValues).fill(0).map((_, index) => {
      return "\r\n" + "	".repeat(index);
    })
  }
};
var supportedEols = ["\n", "\r", "\r\n"];

// node_modules/jsonc-parser/lib/esm/impl/format.js
function format(documentText, range, options) {
  let initialIndentLevel;
  let formatText;
  let formatTextStart;
  let rangeStart;
  let rangeEnd;
  if (range) {
    rangeStart = range.offset;
    rangeEnd = rangeStart + range.length;
    formatTextStart = rangeStart;
    while (formatTextStart > 0 && !isEOL(documentText, formatTextStart - 1)) {
      formatTextStart--;
    }
    let endOffset = rangeEnd;
    while (endOffset < documentText.length && !isEOL(documentText, endOffset)) {
      endOffset++;
    }
    formatText = documentText.substring(formatTextStart, endOffset);
    initialIndentLevel = computeIndentLevel(formatText, options);
  } else {
    formatText = documentText;
    initialIndentLevel = 0;
    formatTextStart = 0;
    rangeStart = 0;
    rangeEnd = documentText.length;
  }
  const eol = getEOL(options, documentText);
  const eolFastPathSupported = supportedEols.includes(eol);
  let numberLineBreaks = 0;
  let indentLevel = 0;
  let indentValue;
  if (options.insertSpaces) {
    indentValue = cachedSpaces[options.tabSize || 4] ?? repeat(cachedSpaces[1], options.tabSize || 4);
  } else {
    indentValue = "	";
  }
  const indentType = indentValue === "	" ? "	" : " ";
  let scanner = createScanner(formatText, false);
  let hasError = false;
  function newLinesAndIndent() {
    if (numberLineBreaks > 1) {
      return repeat(eol, numberLineBreaks) + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    const amountOfSpaces = indentValue.length * (initialIndentLevel + indentLevel);
    if (!eolFastPathSupported || amountOfSpaces > cachedBreakLinesWithSpaces[indentType][eol].length) {
      return eol + repeat(indentValue, initialIndentLevel + indentLevel);
    }
    if (amountOfSpaces <= 0) {
      return eol;
    }
    return cachedBreakLinesWithSpaces[indentType][eol][amountOfSpaces];
  }
  function scanNext() {
    let token = scanner.scan();
    numberLineBreaks = 0;
    while (token === 15 || token === 14) {
      if (token === 14 && options.keepLines) {
        numberLineBreaks += 1;
      } else if (token === 14) {
        numberLineBreaks = 1;
      }
      token = scanner.scan();
    }
    hasError = token === 16 || scanner.getTokenError() !== 0;
    return token;
  }
  const editOperations = [];
  function addEdit(text, startOffset, endOffset) {
    if (!hasError && (!range || startOffset < rangeEnd && endOffset > rangeStart) && documentText.substring(startOffset, endOffset) !== text) {
      editOperations.push({ offset: startOffset, length: endOffset - startOffset, content: text });
    }
  }
  let firstToken = scanNext();
  if (options.keepLines && numberLineBreaks > 0) {
    addEdit(repeat(eol, numberLineBreaks), 0, 0);
  }
  if (firstToken !== 17) {
    let firstTokenStart = scanner.getTokenOffset() + formatTextStart;
    let initialIndent = indentValue.length * initialIndentLevel < 20 && options.insertSpaces ? cachedSpaces[indentValue.length * initialIndentLevel] : repeat(indentValue, initialIndentLevel);
    addEdit(initialIndent, formatTextStart, firstTokenStart);
  }
  while (firstToken !== 17) {
    let firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
    let secondToken = scanNext();
    let replaceContent = "";
    let needsLineBreak = false;
    while (numberLineBreaks === 0 && (secondToken === 12 || secondToken === 13)) {
      let commentTokenStart = scanner.getTokenOffset() + formatTextStart;
      addEdit(cachedSpaces[1], firstTokenEnd, commentTokenStart);
      firstTokenEnd = scanner.getTokenOffset() + scanner.getTokenLength() + formatTextStart;
      needsLineBreak = secondToken === 12;
      replaceContent = needsLineBreak ? newLinesAndIndent() : "";
      secondToken = scanNext();
    }
    if (secondToken === 2) {
      if (firstToken !== 1) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 1) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else if (secondToken === 4) {
      if (firstToken !== 3) {
        indentLevel--;
      }
      ;
      if (options.keepLines && numberLineBreaks > 0 || !options.keepLines && firstToken !== 3) {
        replaceContent = newLinesAndIndent();
      } else if (options.keepLines) {
        replaceContent = cachedSpaces[1];
      }
    } else {
      switch (firstToken) {
        case 3:
        case 1:
          indentLevel++;
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 5:
          if (options.keepLines && numberLineBreaks > 0 || !options.keepLines) {
            replaceContent = newLinesAndIndent();
          } else {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 12:
          replaceContent = newLinesAndIndent();
          break;
        case 13:
          if (numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 6:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (!needsLineBreak) {
            replaceContent = cachedSpaces[1];
          }
          break;
        case 10:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else if (secondToken === 6 && !needsLineBreak) {
            replaceContent = "";
          }
          break;
        case 7:
        case 8:
        case 9:
        case 11:
        case 2:
        case 4:
          if (options.keepLines && numberLineBreaks > 0) {
            replaceContent = newLinesAndIndent();
          } else {
            if ((secondToken === 12 || secondToken === 13) && !needsLineBreak) {
              replaceContent = cachedSpaces[1];
            } else if (secondToken !== 5 && secondToken !== 17) {
              hasError = true;
            }
          }
          break;
        case 16:
          hasError = true;
          break;
      }
      if (numberLineBreaks > 0 && (secondToken === 12 || secondToken === 13)) {
        replaceContent = newLinesAndIndent();
      }
    }
    if (secondToken === 17) {
      if (options.keepLines && numberLineBreaks > 0) {
        replaceContent = newLinesAndIndent();
      } else {
        replaceContent = options.insertFinalNewline ? eol : "";
      }
    }
    const secondTokenStart = scanner.getTokenOffset() + formatTextStart;
    addEdit(replaceContent, firstTokenEnd, secondTokenStart);
    firstToken = secondToken;
  }
  return editOperations;
}
function repeat(s, count) {
  let result = "";
  for (let i = 0; i < count; i++) {
    result += s;
  }
  return result;
}
function computeIndentLevel(content, options) {
  let i = 0;
  let nChars = 0;
  const tabSize = options.tabSize || 4;
  while (i < content.length) {
    let ch = content.charAt(i);
    if (ch === cachedSpaces[1]) {
      nChars++;
    } else if (ch === "	") {
      nChars += tabSize;
    } else {
      break;
    }
    i++;
  }
  return Math.floor(nChars / tabSize);
}
function getEOL(options, text) {
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (i + 1 < text.length && text.charAt(i + 1) === "\n") {
        return "\r\n";
      }
      return "\r";
    } else if (ch === "\n") {
      return "\n";
    }
  }
  return options && options.eol || "\n";
}
function isEOL(text, offset) {
  return "\r\n".indexOf(text.charAt(offset)) !== -1;
}

// node_modules/jsonc-parser/lib/esm/impl/parser.js
var ParseOptions;
(function(ParseOptions2) {
  ParseOptions2.DEFAULT = {
    allowTrailingComma: false
  };
})(ParseOptions || (ParseOptions = {}));
function parse(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentProperty = null;
  let currentParent = [];
  const previousParents = [];
  function onValue(value) {
    if (Array.isArray(currentParent)) {
      currentParent.push(value);
    } else if (currentProperty !== null) {
      currentParent[currentProperty] = value;
    }
  }
  const visitor = {
    onObjectBegin: () => {
      const object = {};
      onValue(object);
      previousParents.push(currentParent);
      currentParent = object;
      currentProperty = null;
    },
    onObjectProperty: (name) => {
      currentProperty = name;
    },
    onObjectEnd: () => {
      currentParent = previousParents.pop();
    },
    onArrayBegin: () => {
      const array = [];
      onValue(array);
      previousParents.push(currentParent);
      currentParent = array;
      currentProperty = null;
    },
    onArrayEnd: () => {
      currentParent = previousParents.pop();
    },
    onLiteralValue: onValue,
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  return currentParent[0];
}
function parseTree(text, errors = [], options = ParseOptions.DEFAULT) {
  let currentParent = { type: "array", offset: -1, length: -1, children: [], parent: void 0 };
  function ensurePropertyComplete(endOffset) {
    if (currentParent.type === "property") {
      currentParent.length = endOffset - currentParent.offset;
      currentParent = currentParent.parent;
    }
  }
  function onValue(valueNode) {
    currentParent.children.push(valueNode);
    return valueNode;
  }
  const visitor = {
    onObjectBegin: (offset) => {
      currentParent = onValue({ type: "object", offset, length: -1, parent: currentParent, children: [] });
    },
    onObjectProperty: (name, offset, length) => {
      currentParent = onValue({ type: "property", offset, length: -1, parent: currentParent, children: [] });
      currentParent.children.push({ type: "string", value: name, offset, length, parent: currentParent });
    },
    onObjectEnd: (offset, length) => {
      ensurePropertyComplete(offset + length);
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onArrayBegin: (offset, length) => {
      currentParent = onValue({ type: "array", offset, length: -1, parent: currentParent, children: [] });
    },
    onArrayEnd: (offset, length) => {
      currentParent.length = offset + length - currentParent.offset;
      currentParent = currentParent.parent;
      ensurePropertyComplete(offset + length);
    },
    onLiteralValue: (value, offset, length) => {
      onValue({ type: getNodeType(value), offset, length, parent: currentParent, value });
      ensurePropertyComplete(offset + length);
    },
    onSeparator: (sep, offset, length) => {
      if (currentParent.type === "property") {
        if (sep === ":") {
          currentParent.colonOffset = offset;
        } else if (sep === ",") {
          ensurePropertyComplete(offset);
        }
      }
    },
    onError: (error, offset, length) => {
      errors.push({ error, offset, length });
    }
  };
  visit(text, visitor, options);
  const result = currentParent.children[0];
  if (result) {
    delete result.parent;
  }
  return result;
}
function findNodeAtLocation(root, path4) {
  if (!root) {
    return void 0;
  }
  let node = root;
  for (let segment of path4) {
    if (typeof segment === "string") {
      if (node.type !== "object" || !Array.isArray(node.children)) {
        return void 0;
      }
      let found = false;
      for (const propertyNode of node.children) {
        if (Array.isArray(propertyNode.children) && propertyNode.children[0].value === segment && propertyNode.children.length === 2) {
          node = propertyNode.children[1];
          found = true;
          break;
        }
      }
      if (!found) {
        return void 0;
      }
    } else {
      const index = segment;
      if (node.type !== "array" || index < 0 || !Array.isArray(node.children) || index >= node.children.length) {
        return void 0;
      }
      node = node.children[index];
    }
  }
  return node;
}
function visit(text, visitor, options = ParseOptions.DEFAULT) {
  const _scanner = createScanner(text, false);
  const _jsonPath = [];
  let suppressedCallbacks = 0;
  function toNoArgVisit(visitFunction) {
    return visitFunction ? () => suppressedCallbacks === 0 && visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisit(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter()) : () => true;
  }
  function toOneArgVisitWithPath(visitFunction) {
    return visitFunction ? (arg) => suppressedCallbacks === 0 && visitFunction(arg, _scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice()) : () => true;
  }
  function toBeginVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks++;
      } else {
        let cbReturn = visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter(), () => _jsonPath.slice());
        if (cbReturn === false) {
          suppressedCallbacks = 1;
        }
      }
    } : () => true;
  }
  function toEndVisit(visitFunction) {
    return visitFunction ? () => {
      if (suppressedCallbacks > 0) {
        suppressedCallbacks--;
      }
      if (suppressedCallbacks === 0) {
        visitFunction(_scanner.getTokenOffset(), _scanner.getTokenLength(), _scanner.getTokenStartLine(), _scanner.getTokenStartCharacter());
      }
    } : () => true;
  }
  const onObjectBegin = toBeginVisit(visitor.onObjectBegin), onObjectProperty = toOneArgVisitWithPath(visitor.onObjectProperty), onObjectEnd = toEndVisit(visitor.onObjectEnd), onArrayBegin = toBeginVisit(visitor.onArrayBegin), onArrayEnd = toEndVisit(visitor.onArrayEnd), onLiteralValue = toOneArgVisitWithPath(visitor.onLiteralValue), onSeparator = toOneArgVisit(visitor.onSeparator), onComment = toNoArgVisit(visitor.onComment), onError = toOneArgVisit(visitor.onError);
  const disallowComments = options && options.disallowComments;
  const allowTrailingComma = options && options.allowTrailingComma;
  function scanNext() {
    while (true) {
      const token = _scanner.scan();
      switch (_scanner.getTokenError()) {
        case 4:
          handleError(
            14
            /* ParseErrorCode.InvalidUnicode */
          );
          break;
        case 5:
          handleError(
            15
            /* ParseErrorCode.InvalidEscapeCharacter */
          );
          break;
        case 3:
          handleError(
            13
            /* ParseErrorCode.UnexpectedEndOfNumber */
          );
          break;
        case 1:
          if (!disallowComments) {
            handleError(
              11
              /* ParseErrorCode.UnexpectedEndOfComment */
            );
          }
          break;
        case 2:
          handleError(
            12
            /* ParseErrorCode.UnexpectedEndOfString */
          );
          break;
        case 6:
          handleError(
            16
            /* ParseErrorCode.InvalidCharacter */
          );
          break;
      }
      switch (token) {
        case 12:
        case 13:
          if (disallowComments) {
            handleError(
              10
              /* ParseErrorCode.InvalidCommentToken */
            );
          } else {
            onComment();
          }
          break;
        case 16:
          handleError(
            1
            /* ParseErrorCode.InvalidSymbol */
          );
          break;
        case 15:
        case 14:
          break;
        default:
          return token;
      }
    }
  }
  function handleError(error, skipUntilAfter = [], skipUntil = []) {
    onError(error);
    if (skipUntilAfter.length + skipUntil.length > 0) {
      let token = _scanner.getToken();
      while (token !== 17) {
        if (skipUntilAfter.indexOf(token) !== -1) {
          scanNext();
          break;
        } else if (skipUntil.indexOf(token) !== -1) {
          break;
        }
        token = scanNext();
      }
    }
  }
  function parseString(isValue) {
    const value = _scanner.getTokenValue();
    if (isValue) {
      onLiteralValue(value);
    } else {
      onObjectProperty(value);
      _jsonPath.push(value);
    }
    scanNext();
    return true;
  }
  function parseLiteral() {
    switch (_scanner.getToken()) {
      case 11:
        const tokenValue = _scanner.getTokenValue();
        let value = Number(tokenValue);
        if (isNaN(value)) {
          handleError(
            2
            /* ParseErrorCode.InvalidNumberFormat */
          );
          value = 0;
        }
        onLiteralValue(value);
        break;
      case 7:
        onLiteralValue(null);
        break;
      case 8:
        onLiteralValue(true);
        break;
      case 9:
        onLiteralValue(false);
        break;
      default:
        return false;
    }
    scanNext();
    return true;
  }
  function parseProperty() {
    if (_scanner.getToken() !== 10) {
      handleError(3, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
      return false;
    }
    parseString(false);
    if (_scanner.getToken() === 6) {
      onSeparator(":");
      scanNext();
      if (!parseValue()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
    } else {
      handleError(5, [], [
        2,
        5
        /* SyntaxKind.CommaToken */
      ]);
    }
    _jsonPath.pop();
    return true;
  }
  function parseObject() {
    onObjectBegin();
    scanNext();
    let needsComma = false;
    while (_scanner.getToken() !== 2 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 2 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (!parseProperty()) {
        handleError(4, [], [
          2,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onObjectEnd();
    if (_scanner.getToken() !== 2) {
      handleError(7, [
        2
        /* SyntaxKind.CloseBraceToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseArray() {
    onArrayBegin();
    scanNext();
    let isFirstElement = true;
    let needsComma = false;
    while (_scanner.getToken() !== 4 && _scanner.getToken() !== 17) {
      if (_scanner.getToken() === 5) {
        if (!needsComma) {
          handleError(4, [], []);
        }
        onSeparator(",");
        scanNext();
        if (_scanner.getToken() === 4 && allowTrailingComma) {
          break;
        }
      } else if (needsComma) {
        handleError(6, [], []);
      }
      if (isFirstElement) {
        _jsonPath.push(0);
        isFirstElement = false;
      } else {
        _jsonPath[_jsonPath.length - 1]++;
      }
      if (!parseValue()) {
        handleError(4, [], [
          4,
          5
          /* SyntaxKind.CommaToken */
        ]);
      }
      needsComma = true;
    }
    onArrayEnd();
    if (!isFirstElement) {
      _jsonPath.pop();
    }
    if (_scanner.getToken() !== 4) {
      handleError(8, [
        4
        /* SyntaxKind.CloseBracketToken */
      ], []);
    } else {
      scanNext();
    }
    return true;
  }
  function parseValue() {
    switch (_scanner.getToken()) {
      case 3:
        return parseArray();
      case 1:
        return parseObject();
      case 10:
        return parseString(true);
      default:
        return parseLiteral();
    }
  }
  scanNext();
  if (_scanner.getToken() === 17) {
    if (options.allowEmptyContent) {
      return true;
    }
    handleError(4, [], []);
    return false;
  }
  if (!parseValue()) {
    handleError(4, [], []);
    return false;
  }
  if (_scanner.getToken() !== 17) {
    handleError(9, [], []);
  }
  return true;
}
function getNodeType(value) {
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object": {
      if (!value) {
        return "null";
      } else if (Array.isArray(value)) {
        return "array";
      }
      return "object";
    }
    default:
      return "null";
  }
}

// node_modules/jsonc-parser/lib/esm/impl/edit.js
function setProperty(text, originalPath, value, options) {
  const path4 = originalPath.slice();
  const errors = [];
  const root = parseTree(text, errors);
  let parent = void 0;
  let lastSegment = void 0;
  while (path4.length > 0) {
    lastSegment = path4.pop();
    parent = findNodeAtLocation(root, path4);
    if (parent === void 0 && value !== void 0) {
      if (typeof lastSegment === "string") {
        value = { [lastSegment]: value };
      } else {
        value = [value];
      }
    } else {
      break;
    }
  }
  if (!parent) {
    if (value === void 0) {
      throw new Error("Can not delete in empty document");
    }
    return withFormatting(text, { offset: root ? root.offset : 0, length: root ? root.length : 0, content: JSON.stringify(value) }, options);
  } else if (parent.type === "object" && typeof lastSegment === "string" && Array.isArray(parent.children)) {
    const existing = findNodeAtLocation(parent, [lastSegment]);
    if (existing !== void 0) {
      if (value === void 0) {
        if (!existing.parent) {
          throw new Error("Malformed AST");
        }
        const propertyIndex = parent.children.indexOf(existing.parent);
        let removeBegin;
        let removeEnd = existing.parent.offset + existing.parent.length;
        if (propertyIndex > 0) {
          let previous = parent.children[propertyIndex - 1];
          removeBegin = previous.offset + previous.length;
        } else {
          removeBegin = parent.offset + 1;
          if (parent.children.length > 1) {
            let next = parent.children[1];
            removeEnd = next.offset;
          }
        }
        return withFormatting(text, { offset: removeBegin, length: removeEnd - removeBegin, content: "" }, options);
      } else {
        return withFormatting(text, { offset: existing.offset, length: existing.length, content: JSON.stringify(value) }, options);
      }
    } else {
      if (value === void 0) {
        return [];
      }
      const newProperty = `${JSON.stringify(lastSegment)}: ${JSON.stringify(value)}`;
      const index = options.getInsertionIndex ? options.getInsertionIndex(parent.children.map((p) => p.children[0].value)) : parent.children.length;
      let edit2;
      if (index > 0) {
        let previous = parent.children[index - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      } else if (parent.children.length === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty + "," };
      }
      return withFormatting(text, edit2, options);
    }
  } else if (parent.type === "array" && typeof lastSegment === "number" && Array.isArray(parent.children)) {
    const insertIndex = lastSegment;
    if (insertIndex === -1) {
      const newProperty = `${JSON.stringify(value)}`;
      let edit2;
      if (parent.children.length === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: newProperty };
      } else {
        const previous = parent.children[parent.children.length - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit2, options);
    } else if (value === void 0 && parent.children.length >= 0) {
      const removalIndex = lastSegment;
      const toRemove = parent.children[removalIndex];
      let edit2;
      if (parent.children.length === 1) {
        edit2 = { offset: parent.offset + 1, length: parent.length - 2, content: "" };
      } else if (parent.children.length - 1 === removalIndex) {
        let previous = parent.children[removalIndex - 1];
        let offset = previous.offset + previous.length;
        let parentEndOffset = parent.offset + parent.length;
        edit2 = { offset, length: parentEndOffset - 2 - offset, content: "" };
      } else {
        edit2 = { offset: toRemove.offset, length: parent.children[removalIndex + 1].offset - toRemove.offset, content: "" };
      }
      return withFormatting(text, edit2, options);
    } else if (value !== void 0) {
      let edit2;
      const newProperty = `${JSON.stringify(value)}`;
      if (!options.isArrayInsertion && parent.children.length > lastSegment) {
        const toModify = parent.children[lastSegment];
        edit2 = { offset: toModify.offset, length: toModify.length, content: newProperty };
      } else if (parent.children.length === 0 || lastSegment === 0) {
        edit2 = { offset: parent.offset + 1, length: 0, content: parent.children.length === 0 ? newProperty : newProperty + "," };
      } else {
        const index = lastSegment > parent.children.length ? parent.children.length : lastSegment;
        const previous = parent.children[index - 1];
        edit2 = { offset: previous.offset + previous.length, length: 0, content: "," + newProperty };
      }
      return withFormatting(text, edit2, options);
    } else {
      throw new Error(`Can not ${value === void 0 ? "remove" : options.isArrayInsertion ? "insert" : "modify"} Array index ${insertIndex} as length is not sufficient`);
    }
  } else {
    throw new Error(`Can not add ${typeof lastSegment !== "number" ? "index" : "property"} to parent of type ${parent.type}`);
  }
}
function withFormatting(text, edit2, options) {
  if (!options.formattingOptions) {
    return [edit2];
  }
  let newText = applyEdit(text, edit2);
  let begin = edit2.offset;
  let end = edit2.offset + edit2.content.length;
  if (edit2.length === 0 || edit2.content.length === 0) {
    while (begin > 0 && !isEOL(newText, begin - 1)) {
      begin--;
    }
    while (end < newText.length && !isEOL(newText, end)) {
      end++;
    }
  }
  const edits = format(newText, { offset: begin, length: end - begin }, { ...options.formattingOptions, keepLines: false });
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit3 = edits[i];
    newText = applyEdit(newText, edit3);
    begin = Math.min(begin, edit3.offset);
    end = Math.max(end, edit3.offset + edit3.length);
    end += edit3.content.length - edit3.length;
  }
  const editLength = text.length - (newText.length - end) - begin;
  return [{ offset: begin, length: editLength, content: newText.substring(begin, end) }];
}
function applyEdit(text, edit2) {
  return text.substring(0, edit2.offset) + edit2.content + text.substring(edit2.offset + edit2.length);
}

// node_modules/jsonc-parser/lib/esm/main.js
var ScanError;
(function(ScanError2) {
  ScanError2[ScanError2["None"] = 0] = "None";
  ScanError2[ScanError2["UnexpectedEndOfComment"] = 1] = "UnexpectedEndOfComment";
  ScanError2[ScanError2["UnexpectedEndOfString"] = 2] = "UnexpectedEndOfString";
  ScanError2[ScanError2["UnexpectedEndOfNumber"] = 3] = "UnexpectedEndOfNumber";
  ScanError2[ScanError2["InvalidUnicode"] = 4] = "InvalidUnicode";
  ScanError2[ScanError2["InvalidEscapeCharacter"] = 5] = "InvalidEscapeCharacter";
  ScanError2[ScanError2["InvalidCharacter"] = 6] = "InvalidCharacter";
})(ScanError || (ScanError = {}));
var SyntaxKind;
(function(SyntaxKind2) {
  SyntaxKind2[SyntaxKind2["OpenBraceToken"] = 1] = "OpenBraceToken";
  SyntaxKind2[SyntaxKind2["CloseBraceToken"] = 2] = "CloseBraceToken";
  SyntaxKind2[SyntaxKind2["OpenBracketToken"] = 3] = "OpenBracketToken";
  SyntaxKind2[SyntaxKind2["CloseBracketToken"] = 4] = "CloseBracketToken";
  SyntaxKind2[SyntaxKind2["CommaToken"] = 5] = "CommaToken";
  SyntaxKind2[SyntaxKind2["ColonToken"] = 6] = "ColonToken";
  SyntaxKind2[SyntaxKind2["NullKeyword"] = 7] = "NullKeyword";
  SyntaxKind2[SyntaxKind2["TrueKeyword"] = 8] = "TrueKeyword";
  SyntaxKind2[SyntaxKind2["FalseKeyword"] = 9] = "FalseKeyword";
  SyntaxKind2[SyntaxKind2["StringLiteral"] = 10] = "StringLiteral";
  SyntaxKind2[SyntaxKind2["NumericLiteral"] = 11] = "NumericLiteral";
  SyntaxKind2[SyntaxKind2["LineCommentTrivia"] = 12] = "LineCommentTrivia";
  SyntaxKind2[SyntaxKind2["BlockCommentTrivia"] = 13] = "BlockCommentTrivia";
  SyntaxKind2[SyntaxKind2["LineBreakTrivia"] = 14] = "LineBreakTrivia";
  SyntaxKind2[SyntaxKind2["Trivia"] = 15] = "Trivia";
  SyntaxKind2[SyntaxKind2["Unknown"] = 16] = "Unknown";
  SyntaxKind2[SyntaxKind2["EOF"] = 17] = "EOF";
})(SyntaxKind || (SyntaxKind = {}));
var parse2 = parse;
var ParseErrorCode;
(function(ParseErrorCode2) {
  ParseErrorCode2[ParseErrorCode2["InvalidSymbol"] = 1] = "InvalidSymbol";
  ParseErrorCode2[ParseErrorCode2["InvalidNumberFormat"] = 2] = "InvalidNumberFormat";
  ParseErrorCode2[ParseErrorCode2["PropertyNameExpected"] = 3] = "PropertyNameExpected";
  ParseErrorCode2[ParseErrorCode2["ValueExpected"] = 4] = "ValueExpected";
  ParseErrorCode2[ParseErrorCode2["ColonExpected"] = 5] = "ColonExpected";
  ParseErrorCode2[ParseErrorCode2["CommaExpected"] = 6] = "CommaExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBraceExpected"] = 7] = "CloseBraceExpected";
  ParseErrorCode2[ParseErrorCode2["CloseBracketExpected"] = 8] = "CloseBracketExpected";
  ParseErrorCode2[ParseErrorCode2["EndOfFileExpected"] = 9] = "EndOfFileExpected";
  ParseErrorCode2[ParseErrorCode2["InvalidCommentToken"] = 10] = "InvalidCommentToken";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfComment"] = 11] = "UnexpectedEndOfComment";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfString"] = 12] = "UnexpectedEndOfString";
  ParseErrorCode2[ParseErrorCode2["UnexpectedEndOfNumber"] = 13] = "UnexpectedEndOfNumber";
  ParseErrorCode2[ParseErrorCode2["InvalidUnicode"] = 14] = "InvalidUnicode";
  ParseErrorCode2[ParseErrorCode2["InvalidEscapeCharacter"] = 15] = "InvalidEscapeCharacter";
  ParseErrorCode2[ParseErrorCode2["InvalidCharacter"] = 16] = "InvalidCharacter";
})(ParseErrorCode || (ParseErrorCode = {}));
function modify(text, path4, value, options) {
  return setProperty(text, path4, value, options);
}
function applyEdits(text, edits) {
  let sortedEdits = edits.slice(0).sort((a, b) => {
    const diff = a.offset - b.offset;
    if (diff === 0) {
      return a.length - b.length;
    }
    return diff;
  });
  let lastModifiedOffset = text.length;
  for (let i = sortedEdits.length - 1; i >= 0; i--) {
    let e = sortedEdits[i];
    if (e.offset + e.length <= lastModifiedOffset) {
      text = applyEdit(text, e);
    } else {
      throw new Error("Overlapping edit");
    }
    lastModifiedOffset = e.offset;
  }
  return text;
}

// core/sources.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "_backup", "_backups", ".backup", "backup"]);
function defaultRoots(cwd = process.cwd()) {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".config", "opencode", "skill"),
    path.join(home, ".opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(cwd, ".opencode", "skills")
  ];
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}
function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last2 = value[value.length - 1];
    if (first === '"' && last2 === '"' || first === "'" && last2 === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}
var BLOCK_HEADER = /^[A-Za-z_][\w-]*:\s*[|>][-+]?\s*$/;
var KV_LINE = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/;
function parseFrontmatter(text) {
  const src = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false, bodyLineOffset: 0 };
  const data = {};
  const lines = m[1].split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i += 1;
      continue;
    }
    const kv = KV_LINE.exec(line);
    if (!kv) {
      i += 1;
      continue;
    }
    const key = kv[1];
    let value = kv[2].trim();
    i += 1;
    if (BLOCK_HEADER.test(line)) {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = value.startsWith(">") ? block.join(" ") : block.join("\n");
    } else if (value === "") {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "") {
        block.push(lines[i].trim());
        i += 1;
      }
      value = block.join(" ");
    } else {
      const block = [];
      while (i < lines.length && /^[ \t]/.test(lines[i]) && lines[i].trim() !== "" && !KV_LINE.test(lines[i].trim())) {
        block.push(lines[i].trim());
        i += 1;
      }
      if (block.length > 0) value = [value, ...block].join(" ");
    }
    data[key] = unquote(value);
  }
  const bodyLineOffset = m[0].split(/\r?\n/).length - 1;
  return { data, body: src.slice(m[0].length), hasFrontmatter: true, bodyLineOffset };
}
function extractHeadings(body) {
  const out2 = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out2.push(m[2]);
  }
  return out2;
}
function parseSkill(text) {
  const { data, body } = parseFrontmatter(text);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return { name, description, bodyHeadings: extractHeadings(body) };
}
function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) {
      yield full;
    }
  }
}
function isInsideRoot(realRoot, realTarget) {
  const rel = path.relative(realRoot, realTarget);
  return !(rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}
function discoverSkills(roots = defaultRoots()) {
  const seen = /* @__PURE__ */ new Map();
  const skipped = [];
  for (const root of roots) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      continue;
    }
    for (const file of walk(root)) {
      let real;
      try {
        real = fs.realpathSync(file);
      } catch {
        continue;
      }
      if (!isInsideRoot(realRoot, real)) {
        skipped.push({ path: file, root, reason: "outside-root" });
        continue;
      }
      if (seen.has(real)) continue;
      let text;
      try {
        text = fs.readFileSync(real, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkill(text);
      seen.set(real, {
        name: parsed.name || path.basename(path.dirname(real)),
        path: real,
        description: parsed.description,
        bodyHeadings: parsed.bodyHeadings,
        root
      });
    }
  }
  return { skills: [...seen.values()], skipped };
}

// core/index.mjs
import fs2 from "node:fs";
import { fileURLToPath } from "node:url";

// node_modules/minisearch/dist/es/index.js
var ENTRIES = "ENTRIES";
var KEYS = "KEYS";
var VALUES = "VALUES";
var LEAF = "";
var TreeIterator = class {
  constructor(set, type) {
    const node = set._tree;
    const keys = Array.from(node.keys());
    this.set = set;
    this._type = type;
    this._path = keys.length > 0 ? [{ node, keys }] : [];
  }
  next() {
    const value = this.dive();
    this.backtrack();
    return value;
  }
  dive() {
    if (this._path.length === 0) {
      return { done: true, value: void 0 };
    }
    const { node, keys } = last$1(this._path);
    if (last$1(keys) === LEAF) {
      return { done: false, value: this.result() };
    }
    const child = node.get(last$1(keys));
    this._path.push({ node: child, keys: Array.from(child.keys()) });
    return this.dive();
  }
  backtrack() {
    if (this._path.length === 0) {
      return;
    }
    const keys = last$1(this._path).keys;
    keys.pop();
    if (keys.length > 0) {
      return;
    }
    this._path.pop();
    this.backtrack();
  }
  key() {
    return this.set._prefix + this._path.map(({ keys }) => last$1(keys)).filter((key) => key !== LEAF).join("");
  }
  value() {
    return last$1(this._path).node.get(LEAF);
  }
  result() {
    switch (this._type) {
      case VALUES:
        return this.value();
      case KEYS:
        return this.key();
      default:
        return [this.key(), this.value()];
    }
  }
  [Symbol.iterator]() {
    return this;
  }
};
var last$1 = (array) => {
  return array[array.length - 1];
};
var fuzzySearch = (node, query, maxDistance) => {
  const results = /* @__PURE__ */ new Map();
  if (query === void 0)
    return results;
  const n = query.length + 1;
  const m = n + maxDistance;
  const matrix = new Uint8Array(m * n).fill(maxDistance + 1);
  for (let j = 0; j < n; ++j)
    matrix[j] = j;
  for (let i = 1; i < m; ++i)
    matrix[i * n] = i;
  recurse(node, query, maxDistance, results, matrix, 1, n, "");
  return results;
};
var recurse = (node, query, maxDistance, results, matrix, m, n, prefix) => {
  const offset = m * n;
  key: for (const key of node.keys()) {
    if (key === LEAF) {
      const distance = matrix[offset - 1];
      if (distance <= maxDistance) {
        results.set(prefix, [node.get(key), distance]);
      }
    } else {
      let i = m;
      for (let pos = 0; pos < key.length; ++pos, ++i) {
        const char = key[pos];
        const thisRowOffset = n * i;
        const prevRowOffset = thisRowOffset - n;
        let minDistance = matrix[thisRowOffset];
        const jmin = Math.max(0, i - maxDistance - 1);
        const jmax = Math.min(n - 1, i + maxDistance);
        for (let j = jmin; j < jmax; ++j) {
          const different = char !== query[j];
          const rpl = matrix[prevRowOffset + j] + +different;
          const del = matrix[prevRowOffset + j + 1] + 1;
          const ins = matrix[thisRowOffset + j] + 1;
          const dist = matrix[thisRowOffset + j + 1] = Math.min(rpl, del, ins);
          if (dist < minDistance)
            minDistance = dist;
        }
        if (minDistance > maxDistance) {
          continue key;
        }
      }
      recurse(node.get(key), query, maxDistance, results, matrix, i, n, prefix + key);
    }
  }
};
var SearchableMap = class _SearchableMap {
  /**
   * The constructor is normally called without arguments, creating an empty
   * map. In order to create a {@link SearchableMap} from an iterable or from an
   * object, check {@link SearchableMap.from} and {@link
   * SearchableMap.fromObject}.
   *
   * The constructor arguments are for internal use, when creating derived
   * mutable views of a map at a prefix.
   */
  constructor(tree = /* @__PURE__ */ new Map(), prefix = "") {
    this._size = void 0;
    this._tree = tree;
    this._prefix = prefix;
  }
  /**
   * Creates and returns a mutable view of this {@link SearchableMap},
   * containing only entries that share the given prefix.
   *
   * ### Usage:
   *
   * ```javascript
   * let map = new SearchableMap()
   * map.set("unicorn", 1)
   * map.set("universe", 2)
   * map.set("university", 3)
   * map.set("unique", 4)
   * map.set("hello", 5)
   *
   * let uni = map.atPrefix("uni")
   * uni.get("unique") // => 4
   * uni.get("unicorn") // => 1
   * uni.get("hello") // => undefined
   *
   * let univer = map.atPrefix("univer")
   * univer.get("unique") // => undefined
   * univer.get("universe") // => 2
   * univer.get("university") // => 3
   * ```
   *
   * @param prefix  The prefix
   * @return A {@link SearchableMap} representing a mutable view of the original
   * Map at the given prefix
   */
  atPrefix(prefix) {
    if (!prefix.startsWith(this._prefix)) {
      throw new Error("Mismatched prefix");
    }
    const [node, path4] = trackDown(this._tree, prefix.slice(this._prefix.length));
    if (node === void 0) {
      const [parentNode, key] = last(path4);
      for (const k of parentNode.keys()) {
        if (k !== LEAF && k.startsWith(key)) {
          const node2 = /* @__PURE__ */ new Map();
          node2.set(k.slice(key.length), parentNode.get(k));
          return new _SearchableMap(node2, prefix);
        }
      }
    }
    return new _SearchableMap(node, prefix);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/clear
   */
  clear() {
    this._size = void 0;
    this._tree.clear();
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/delete
   * @param key  Key to delete
   */
  delete(key) {
    this._size = void 0;
    return remove(this._tree, key);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/entries
   * @return An iterator iterating through `[key, value]` entries.
   */
  entries() {
    return new TreeIterator(this, ENTRIES);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/forEach
   * @param fn  Iteration function
   */
  forEach(fn) {
    for (const [key, value] of this) {
      fn(key, value, this);
    }
  }
  /**
   * Returns a Map of all the entries that have a key within the given edit
   * distance from the search key. The keys of the returned Map are the matching
   * keys, while the values are two-element arrays where the first element is
   * the value associated to the key, and the second is the edit distance of the
   * key to the search key.
   *
   * ### Usage:
   *
   * ```javascript
   * let map = new SearchableMap()
   * map.set('hello', 'world')
   * map.set('hell', 'yeah')
   * map.set('ciao', 'mondo')
   *
   * // Get all entries that match the key 'hallo' with a maximum edit distance of 2
   * map.fuzzyGet('hallo', 2)
   * // => Map(2) { 'hello' => ['world', 1], 'hell' => ['yeah', 2] }
   *
   * // In the example, the "hello" key has value "world" and edit distance of 1
   * // (change "e" to "a"), the key "hell" has value "yeah" and edit distance of 2
   * // (change "e" to "a", delete "o")
   * ```
   *
   * @param key  The search key
   * @param maxEditDistance  The maximum edit distance (Levenshtein)
   * @return A Map of the matching keys to their value and edit distance
   */
  fuzzyGet(key, maxEditDistance) {
    return fuzzySearch(this._tree, key, maxEditDistance);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/get
   * @param key  Key to get
   * @return Value associated to the key, or `undefined` if the key is not
   * found.
   */
  get(key) {
    const node = lookup(this._tree, key);
    return node !== void 0 ? node.get(LEAF) : void 0;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/has
   * @param key  Key
   * @return True if the key is in the map, false otherwise
   */
  has(key) {
    const node = lookup(this._tree, key);
    return node !== void 0 && node.has(LEAF);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/keys
   * @return An `Iterable` iterating through keys
   */
  keys() {
    return new TreeIterator(this, KEYS);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/set
   * @param key  Key to set
   * @param value  Value to associate to the key
   * @return The {@link SearchableMap} itself, to allow chaining
   */
  set(key, value) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    node.set(LEAF, value);
    return this;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/size
   */
  get size() {
    if (this._size) {
      return this._size;
    }
    this._size = 0;
    const iter = this.entries();
    while (!iter.next().done)
      this._size += 1;
    return this._size;
  }
  /**
   * Updates the value at the given key using the provided function. The function
   * is called with the current value at the key, and its return value is used as
   * the new value to be set.
   *
   * ### Example:
   *
   * ```javascript
   * // Increment the current value by one
   * searchableMap.update('somekey', (currentValue) => currentValue == null ? 0 : currentValue + 1)
   * ```
   *
   * If the value at the given key is or will be an object, it might not require
   * re-assignment. In that case it is better to use `fetch()`, because it is
   * faster.
   *
   * @param key  The key to update
   * @param fn  The function used to compute the new value from the current one
   * @return The {@link SearchableMap} itself, to allow chaining
   */
  update(key, fn) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    node.set(LEAF, fn(node.get(LEAF)));
    return this;
  }
  /**
   * Fetches the value of the given key. If the value does not exist, calls the
   * given function to create a new value, which is inserted at the given key
   * and subsequently returned.
   *
   * ### Example:
   *
   * ```javascript
   * const map = searchableMap.fetch('somekey', () => new Map())
   * map.set('foo', 'bar')
   * ```
   *
   * @param key  The key to update
   * @param initial  A function that creates a new value if the key does not exist
   * @return The existing or new value at the given key
   */
  fetch(key, initial) {
    if (typeof key !== "string") {
      throw new Error("key must be a string");
    }
    this._size = void 0;
    const node = createPath(this._tree, key);
    let value = node.get(LEAF);
    if (value === void 0) {
      node.set(LEAF, value = initial());
    }
    return value;
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/values
   * @return An `Iterable` iterating through values.
   */
  values() {
    return new TreeIterator(this, VALUES);
  }
  /**
   * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/@@iterator
   */
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
   * Creates a {@link SearchableMap} from an `Iterable` of entries
   *
   * @param entries  Entries to be inserted in the {@link SearchableMap}
   * @return A new {@link SearchableMap} with the given entries
   */
  static from(entries) {
    const tree = new _SearchableMap();
    for (const [key, value] of entries) {
      tree.set(key, value);
    }
    return tree;
  }
  /**
   * Creates a {@link SearchableMap} from the iterable properties of a JavaScript object
   *
   * @param object  Object of entries for the {@link SearchableMap}
   * @return A new {@link SearchableMap} with the given entries
   */
  static fromObject(object) {
    return _SearchableMap.from(Object.entries(object));
  }
};
var trackDown = (tree, key, path4 = []) => {
  if (key.length === 0 || tree == null) {
    return [tree, path4];
  }
  for (const k of tree.keys()) {
    if (k !== LEAF && key.startsWith(k)) {
      path4.push([tree, k]);
      return trackDown(tree.get(k), key.slice(k.length), path4);
    }
  }
  path4.push([tree, key]);
  return trackDown(void 0, "", path4);
};
var lookup = (tree, key) => {
  if (key.length === 0 || tree == null) {
    return tree;
  }
  for (const k of tree.keys()) {
    if (k !== LEAF && key.startsWith(k)) {
      return lookup(tree.get(k), key.slice(k.length));
    }
  }
};
var createPath = (node, key) => {
  const keyLength = key.length;
  outer: for (let pos = 0; node && pos < keyLength; ) {
    for (const k of node.keys()) {
      if (k !== LEAF && key[pos] === k[0]) {
        const len = Math.min(keyLength - pos, k.length);
        let offset = 1;
        while (offset < len && key[pos + offset] === k[offset])
          ++offset;
        const child2 = node.get(k);
        if (offset === k.length) {
          node = child2;
        } else {
          const intermediate = /* @__PURE__ */ new Map();
          intermediate.set(k.slice(offset), child2);
          node.set(key.slice(pos, pos + offset), intermediate);
          node.delete(k);
          node = intermediate;
        }
        pos += offset;
        continue outer;
      }
    }
    const child = /* @__PURE__ */ new Map();
    node.set(key.slice(pos), child);
    return child;
  }
  return node;
};
var remove = (tree, key) => {
  const [node, path4] = trackDown(tree, key);
  if (node === void 0) {
    return;
  }
  node.delete(LEAF);
  if (node.size === 0) {
    cleanup(path4);
  } else if (node.size === 1) {
    const [key2, value] = node.entries().next().value;
    merge(path4, key2, value);
  }
};
var cleanup = (path4) => {
  if (path4.length === 0) {
    return;
  }
  const [node, key] = last(path4);
  node.delete(key);
  if (node.size === 0) {
    cleanup(path4.slice(0, -1));
  } else if (node.size === 1) {
    const [key2, value] = node.entries().next().value;
    if (key2 !== LEAF) {
      merge(path4.slice(0, -1), key2, value);
    }
  }
};
var merge = (path4, key, value) => {
  if (path4.length === 0) {
    return;
  }
  const [node, nodeKey] = last(path4);
  node.set(nodeKey + key, value);
  node.delete(nodeKey);
};
var last = (array) => {
  return array[array.length - 1];
};
var OR = "or";
var AND = "and";
var AND_NOT = "and_not";
var MiniSearch = class _MiniSearch {
  /**
   * @param options  Configuration options
   *
   * ### Examples:
   *
   * ```javascript
   * // Create a search engine that indexes the 'title' and 'text' fields of your
   * // documents:
   * const miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * ```
   *
   * ### ID Field:
   *
   * ```javascript
   * // Your documents are assumed to include a unique 'id' field, but if you want
   * // to use a different field for document identification, you can set the
   * // 'idField' option:
   * const miniSearch = new MiniSearch({ idField: 'key', fields: ['title', 'text'] })
   * ```
   *
   * ### Options and defaults:
   *
   * ```javascript
   * // The full set of options (here with their default value) is:
   * const miniSearch = new MiniSearch({
   *   // idField: field that uniquely identifies a document
   *   idField: 'id',
   *
   *   // extractField: function used to get the value of a field in a document.
   *   // By default, it assumes the document is a flat object with field names as
   *   // property keys and field values as string property values, but custom logic
   *   // can be implemented by setting this option to a custom extractor function.
   *   extractField: (document, fieldName) => document[fieldName],
   *
   *   // tokenize: function used to split fields into individual terms. By
   *   // default, it is also used to tokenize search queries, unless a specific
   *   // `tokenize` search option is supplied. When tokenizing an indexed field,
   *   // the field name is passed as the second argument.
   *   tokenize: (string, _fieldName) => string.split(SPACE_OR_PUNCTUATION),
   *
   *   // processTerm: function used to process each tokenized term before
   *   // indexing. It can be used for stemming and normalization. Return a falsy
   *   // value in order to discard a term. By default, it is also used to process
   *   // search queries, unless a specific `processTerm` option is supplied as a
   *   // search option. When processing a term from a indexed field, the field
   *   // name is passed as the second argument.
   *   processTerm: (term, _fieldName) => term.toLowerCase(),
   *
   *   // searchOptions: default search options, see the `search` method for
   *   // details
   *   searchOptions: undefined,
   *
   *   // fields: document fields to be indexed. Mandatory, but not set by default
   *   fields: undefined
   *
   *   // storeFields: document fields to be stored and returned as part of the
   *   // search results.
   *   storeFields: []
   * })
   * ```
   */
  constructor(options) {
    if ((options === null || options === void 0 ? void 0 : options.fields) == null) {
      throw new Error('MiniSearch: option "fields" must be provided');
    }
    const autoVacuum = options.autoVacuum == null || options.autoVacuum === true ? defaultAutoVacuumOptions : options.autoVacuum;
    this._options = {
      ...defaultOptions,
      ...options,
      autoVacuum,
      searchOptions: { ...defaultSearchOptions, ...options.searchOptions || {} },
      autoSuggestOptions: { ...defaultAutoSuggestOptions, ...options.autoSuggestOptions || {} }
    };
    this._index = new SearchableMap();
    this._documentCount = 0;
    this._documentIds = /* @__PURE__ */ new Map();
    this._idToShortId = /* @__PURE__ */ new Map();
    this._fieldIds = {};
    this._fieldLength = /* @__PURE__ */ new Map();
    this._avgFieldLength = [];
    this._nextId = 0;
    this._storedFields = /* @__PURE__ */ new Map();
    this._dirtCount = 0;
    this._currentVacuum = null;
    this._enqueuedVacuum = null;
    this._enqueuedVacuumConditions = defaultVacuumConditions;
    this.addFields(this._options.fields);
  }
  /**
   * Adds a document to the index
   *
   * @param document  The document to be indexed
   */
  add(document) {
    const { extractField, stringifyField, tokenize: tokenize2, processTerm: processTerm2, fields, idField } = this._options;
    const id = extractField(document, idField);
    if (id == null) {
      throw new Error(`MiniSearch: document does not have ID field "${idField}"`);
    }
    if (this._idToShortId.has(id)) {
      throw new Error(`MiniSearch: duplicate ID ${id}`);
    }
    const shortDocumentId = this.addDocumentId(id);
    this.saveStoredFields(shortDocumentId, document);
    for (const field of fields) {
      const fieldValue = extractField(document, field);
      if (fieldValue == null)
        continue;
      const tokens = tokenize2(stringifyField(fieldValue, field), field);
      const fieldId = this._fieldIds[field];
      const uniqueTerms = new Set(tokens).size;
      this.addFieldLength(shortDocumentId, fieldId, this._documentCount - 1, uniqueTerms);
      for (const term of tokens) {
        const processedTerm = processTerm2(term, field);
        if (Array.isArray(processedTerm)) {
          for (const t of processedTerm) {
            this.addTerm(fieldId, shortDocumentId, t);
          }
        } else if (processedTerm) {
          this.addTerm(fieldId, shortDocumentId, processedTerm);
        }
      }
    }
  }
  /**
   * Adds all the given documents to the index
   *
   * @param documents  An array of documents to be indexed
   */
  addAll(documents) {
    for (const document of documents)
      this.add(document);
  }
  /**
   * Adds all the given documents to the index asynchronously.
   *
   * Returns a promise that resolves (to `undefined`) when the indexing is done.
   * This method is useful when index many documents, to avoid blocking the main
   * thread. The indexing is performed asynchronously and in chunks.
   *
   * @param documents  An array of documents to be indexed
   * @param options  Configuration options
   * @return A promise resolving to `undefined` when the indexing is done
   */
  addAllAsync(documents, options = {}) {
    const { chunkSize = 10 } = options;
    const acc = { chunk: [], promise: Promise.resolve() };
    const { chunk, promise } = documents.reduce(({ chunk: chunk2, promise: promise2 }, document, i) => {
      chunk2.push(document);
      if ((i + 1) % chunkSize === 0) {
        return {
          chunk: [],
          promise: promise2.then(() => new Promise((resolve) => setTimeout(resolve, 0))).then(() => this.addAll(chunk2))
        };
      } else {
        return { chunk: chunk2, promise: promise2 };
      }
    }, acc);
    return promise.then(() => this.addAll(chunk));
  }
  /**
   * Removes the given document from the index.
   *
   * The document to remove must NOT have changed between indexing and removal,
   * otherwise the index will be corrupted.
   *
   * This method requires passing the full document to be removed (not just the
   * ID), and immediately removes the document from the inverted index, allowing
   * memory to be released. A convenient alternative is {@link
   * MiniSearch#discard}, which needs only the document ID, and has the same
   * visible effect, but delays cleaning up the index until the next vacuuming.
   *
   * @param document  The document to be removed
   */
  remove(document) {
    const { tokenize: tokenize2, processTerm: processTerm2, extractField, stringifyField, fields, idField } = this._options;
    const id = extractField(document, idField);
    if (id == null) {
      throw new Error(`MiniSearch: document does not have ID field "${idField}"`);
    }
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      throw new Error(`MiniSearch: cannot remove document with ID ${id}: it is not in the index`);
    }
    for (const field of fields) {
      const fieldValue = extractField(document, field);
      if (fieldValue == null)
        continue;
      const tokens = tokenize2(stringifyField(fieldValue, field), field);
      const fieldId = this._fieldIds[field];
      const uniqueTerms = new Set(tokens).size;
      this.removeFieldLength(shortId, fieldId, this._documentCount, uniqueTerms);
      for (const term of tokens) {
        const processedTerm = processTerm2(term, field);
        if (Array.isArray(processedTerm)) {
          for (const t of processedTerm) {
            this.removeTerm(fieldId, shortId, t);
          }
        } else if (processedTerm) {
          this.removeTerm(fieldId, shortId, processedTerm);
        }
      }
    }
    this._storedFields.delete(shortId);
    this._documentIds.delete(shortId);
    this._idToShortId.delete(id);
    this._fieldLength.delete(shortId);
    this._documentCount -= 1;
  }
  /**
   * Removes all the given documents from the index. If called with no arguments,
   * it removes _all_ documents from the index.
   *
   * @param documents  The documents to be removed. If this argument is omitted,
   * all documents are removed. Note that, for removing all documents, it is
   * more efficient to call this method with no arguments than to pass all
   * documents.
   */
  removeAll(documents) {
    if (documents) {
      for (const document of documents)
        this.remove(document);
    } else if (arguments.length > 0) {
      throw new Error("Expected documents to be present. Omit the argument to remove all documents.");
    } else {
      this._index = new SearchableMap();
      this._documentCount = 0;
      this._documentIds = /* @__PURE__ */ new Map();
      this._idToShortId = /* @__PURE__ */ new Map();
      this._fieldLength = /* @__PURE__ */ new Map();
      this._avgFieldLength = [];
      this._storedFields = /* @__PURE__ */ new Map();
      this._nextId = 0;
    }
  }
  /**
   * Discards the document with the given ID, so it won't appear in search results
   *
   * It has the same visible effect of {@link MiniSearch.remove} (both cause the
   * document to stop appearing in searches), but a different effect on the
   * internal data structures:
   *
   *   - {@link MiniSearch#remove} requires passing the full document to be
   *   removed as argument, and removes it from the inverted index immediately.
   *
   *   - {@link MiniSearch#discard} instead only needs the document ID, and
   *   works by marking the current version of the document as discarded, so it
   *   is immediately ignored by searches. This is faster and more convenient
   *   than {@link MiniSearch#remove}, but the index is not immediately
   *   modified. To take care of that, vacuuming is performed after a certain
   *   number of documents are discarded, cleaning up the index and allowing
   *   memory to be released.
   *
   * After discarding a document, it is possible to re-add a new version, and
   * only the new version will appear in searches. In other words, discarding
   * and re-adding a document works exactly like removing and re-adding it. The
   * {@link MiniSearch.replace} method can also be used to replace a document
   * with a new version.
   *
   * #### Details about vacuuming
   *
   * Repetite calls to this method would leave obsolete document references in
   * the index, invisible to searches. Two mechanisms take care of cleaning up:
   * clean up during search, and vacuuming.
   *
   *   - Upon search, whenever a discarded ID is found (and ignored for the
   *   results), references to the discarded document are removed from the
   *   inverted index entries for the search terms. This ensures that subsequent
   *   searches for the same terms do not need to skip these obsolete references
   *   again.
   *
   *   - In addition, vacuuming is performed automatically by default (see the
   *   `autoVacuum` field in {@link Options}) after a certain number of
   *   documents are discarded. Vacuuming traverses all terms in the index,
   *   cleaning up all references to discarded documents. Vacuuming can also be
   *   triggered manually by calling {@link MiniSearch#vacuum}.
   *
   * @param id  The ID of the document to be discarded
   */
  discard(id) {
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      throw new Error(`MiniSearch: cannot discard document with ID ${id}: it is not in the index`);
    }
    this._idToShortId.delete(id);
    this._documentIds.delete(shortId);
    this._storedFields.delete(shortId);
    (this._fieldLength.get(shortId) || []).forEach((fieldLength, fieldId) => {
      this.removeFieldLength(shortId, fieldId, this._documentCount, fieldLength);
    });
    this._fieldLength.delete(shortId);
    this._documentCount -= 1;
    this._dirtCount += 1;
    this.maybeAutoVacuum();
  }
  maybeAutoVacuum() {
    if (this._options.autoVacuum === false) {
      return;
    }
    const { minDirtFactor, minDirtCount, batchSize, batchWait } = this._options.autoVacuum;
    this.conditionalVacuum({ batchSize, batchWait }, { minDirtCount, minDirtFactor });
  }
  /**
   * Discards the documents with the given IDs, so they won't appear in search
   * results
   *
   * It is equivalent to calling {@link MiniSearch#discard} for all the given
   * IDs, but with the optimization of triggering at most one automatic
   * vacuuming at the end.
   *
   * Note: to remove all documents from the index, it is faster and more
   * convenient to call {@link MiniSearch.removeAll} with no argument, instead
   * of passing all IDs to this method.
   */
  discardAll(ids) {
    const autoVacuum = this._options.autoVacuum;
    try {
      this._options.autoVacuum = false;
      for (const id of ids) {
        this.discard(id);
      }
    } finally {
      this._options.autoVacuum = autoVacuum;
    }
    this.maybeAutoVacuum();
  }
  /**
   * It replaces an existing document with the given updated version
   *
   * It works by discarding the current version and adding the updated one, so
   * it is functionally equivalent to calling {@link MiniSearch#discard}
   * followed by {@link MiniSearch#add}. The ID of the updated document should
   * be the same as the original one.
   *
   * Since it uses {@link MiniSearch#discard} internally, this method relies on
   * vacuuming to clean up obsolete document references from the index, allowing
   * memory to be released (see {@link MiniSearch#discard}).
   *
   * @param updatedDocument  The updated document to replace the old version
   * with
   */
  replace(updatedDocument) {
    const { idField, extractField } = this._options;
    const id = extractField(updatedDocument, idField);
    this.discard(id);
    this.add(updatedDocument);
  }
  /**
   * Triggers a manual vacuuming, cleaning up references to discarded documents
   * from the inverted index
   *
   * Vacuuming is only useful for applications that use the {@link
   * MiniSearch#discard} or {@link MiniSearch#replace} methods.
   *
   * By default, vacuuming is performed automatically when needed (controlled by
   * the `autoVacuum` field in {@link Options}), so there is usually no need to
   * call this method, unless one wants to make sure to perform vacuuming at a
   * specific moment.
   *
   * Vacuuming traverses all terms in the inverted index in batches, and cleans
   * up references to discarded documents from the posting list, allowing memory
   * to be released.
   *
   * The method takes an optional object as argument with the following keys:
   *
   *   - `batchSize`: the size of each batch (1000 by default)
   *
   *   - `batchWait`: the number of milliseconds to wait between batches (10 by
   *   default)
   *
   * On large indexes, vacuuming could have a non-negligible cost: batching
   * avoids blocking the thread for long, diluting this cost so that it is not
   * negatively affecting the application. Nonetheless, this method should only
   * be called when necessary, and relying on automatic vacuuming is usually
   * better.
   *
   * It returns a promise that resolves (to undefined) when the clean up is
   * completed. If vacuuming is already ongoing at the time this method is
   * called, a new one is enqueued immediately after the ongoing one, and a
   * corresponding promise is returned. However, no more than one vacuuming is
   * enqueued on top of the ongoing one, even if this method is called more
   * times (enqueuing multiple ones would be useless).
   *
   * @param options  Configuration options for the batch size and delay. See
   * {@link VacuumOptions}.
   */
  vacuum(options = {}) {
    return this.conditionalVacuum(options);
  }
  conditionalVacuum(options, conditions) {
    if (this._currentVacuum) {
      this._enqueuedVacuumConditions = this._enqueuedVacuumConditions && conditions;
      if (this._enqueuedVacuum != null) {
        return this._enqueuedVacuum;
      }
      this._enqueuedVacuum = this._currentVacuum.then(() => {
        const conditions2 = this._enqueuedVacuumConditions;
        this._enqueuedVacuumConditions = defaultVacuumConditions;
        return this.performVacuuming(options, conditions2);
      });
      return this._enqueuedVacuum;
    }
    if (this.vacuumConditionsMet(conditions) === false) {
      return Promise.resolve();
    }
    this._currentVacuum = this.performVacuuming(options);
    return this._currentVacuum;
  }
  async performVacuuming(options, conditions) {
    const initialDirtCount = this._dirtCount;
    if (this.vacuumConditionsMet(conditions)) {
      const batchSize = options.batchSize || defaultVacuumOptions.batchSize;
      const batchWait = options.batchWait || defaultVacuumOptions.batchWait;
      let i = 1;
      for (const [term, fieldsData] of this._index) {
        for (const [fieldId, fieldIndex] of fieldsData) {
          for (const [shortId] of fieldIndex) {
            if (this._documentIds.has(shortId)) {
              continue;
            }
            if (fieldIndex.size <= 1) {
              fieldsData.delete(fieldId);
            } else {
              fieldIndex.delete(shortId);
            }
          }
        }
        if (this._index.get(term).size === 0) {
          this._index.delete(term);
        }
        if (i % batchSize === 0) {
          await new Promise((resolve) => setTimeout(resolve, batchWait));
        }
        i += 1;
      }
      this._dirtCount -= initialDirtCount;
    }
    await null;
    this._currentVacuum = this._enqueuedVacuum;
    this._enqueuedVacuum = null;
  }
  vacuumConditionsMet(conditions) {
    if (conditions == null) {
      return true;
    }
    let { minDirtCount, minDirtFactor } = conditions;
    minDirtCount = minDirtCount || defaultAutoVacuumOptions.minDirtCount;
    minDirtFactor = minDirtFactor || defaultAutoVacuumOptions.minDirtFactor;
    return this.dirtCount >= minDirtCount && this.dirtFactor >= minDirtFactor;
  }
  /**
   * Is `true` if a vacuuming operation is ongoing, `false` otherwise
   */
  get isVacuuming() {
    return this._currentVacuum != null;
  }
  /**
   * The number of documents discarded since the most recent vacuuming
   */
  get dirtCount() {
    return this._dirtCount;
  }
  /**
   * A number between 0 and 1 giving an indication about the proportion of
   * documents that are discarded, and can therefore be cleaned up by vacuuming.
   * A value close to 0 means that the index is relatively clean, while a higher
   * value means that the index is relatively dirty, and vacuuming could release
   * memory.
   */
  get dirtFactor() {
    return this._dirtCount / (1 + this._documentCount + this._dirtCount);
  }
  /**
   * Returns `true` if a document with the given ID is present in the index and
   * available for search, `false` otherwise
   *
   * @param id  The document ID
   */
  has(id) {
    return this._idToShortId.has(id);
  }
  /**
   * Returns the stored fields (as configured in the `storeFields` constructor
   * option) for the given document ID. Returns `undefined` if the document is
   * not present in the index.
   *
   * @param id  The document ID
   */
  getStoredFields(id) {
    const shortId = this._idToShortId.get(id);
    if (shortId == null) {
      return void 0;
    }
    return this._storedFields.get(shortId);
  }
  /**
   * Search for documents matching the given search query.
   *
   * The result is a list of scored document IDs matching the query, sorted by
   * descending score, and each including data about which terms were matched and
   * in which fields.
   *
   * ### Basic usage:
   *
   * ```javascript
   * // Search for "zen art motorcycle" with default options: terms have to match
   * // exactly, and individual terms are joined with OR
   * miniSearch.search('zen art motorcycle')
   * // => [ { id: 2, score: 2.77258, match: { ... } }, { id: 4, score: 1.38629, match: { ... } } ]
   * ```
   *
   * ### Restrict search to specific fields:
   *
   * ```javascript
   * // Search only in the 'title' field
   * miniSearch.search('zen', { fields: ['title'] })
   * ```
   *
   * ### Field boosting:
   *
   * ```javascript
   * // Boost a field
   * miniSearch.search('zen', { boost: { title: 2 } })
   * ```
   *
   * ### Prefix search:
   *
   * ```javascript
   * // Search for "moto" with prefix search (it will match documents
   * // containing terms that start with "moto" or "neuro")
   * miniSearch.search('moto neuro', { prefix: true })
   * ```
   *
   * ### Fuzzy search:
   *
   * ```javascript
   * // Search for "ismael" with fuzzy search (it will match documents containing
   * // terms similar to "ismael", with a maximum edit distance of 0.2 term.length
   * // (rounded to nearest integer)
   * miniSearch.search('ismael', { fuzzy: 0.2 })
   * ```
   *
   * ### Combining strategies:
   *
   * ```javascript
   * // Mix of exact match, prefix search, and fuzzy search
   * miniSearch.search('ismael mob', {
   *  prefix: true,
   *  fuzzy: 0.2
   * })
   * ```
   *
   * ### Advanced prefix and fuzzy search:
   *
   * ```javascript
   * // Perform fuzzy and prefix search depending on the search term. Here
   * // performing prefix and fuzzy search only on terms longer than 3 characters
   * miniSearch.search('ismael mob', {
   *  prefix: term => term.length > 3
   *  fuzzy: term => term.length > 3 ? 0.2 : null
   * })
   * ```
   *
   * ### Combine with AND:
   *
   * ```javascript
   * // Combine search terms with AND (to match only documents that contain both
   * // "motorcycle" and "art")
   * miniSearch.search('motorcycle art', { combineWith: 'AND' })
   * ```
   *
   * ### Combine with AND_NOT:
   *
   * There is also an AND_NOT combinator, that finds documents that match the
   * first term, but do not match any of the other terms. This combinator is
   * rarely useful with simple queries, and is meant to be used with advanced
   * query combinations (see later for more details).
   *
   * ### Filtering results:
   *
   * ```javascript
   * // Filter only results in the 'fiction' category (assuming that 'category'
   * // is a stored field)
   * miniSearch.search('motorcycle art', {
   *   filter: (result) => result.category === 'fiction'
   * })
   * ```
   *
   * ### Wildcard query
   *
   * Searching for an empty string (assuming the default tokenizer) returns no
   * results. Sometimes though, one needs to match all documents, like in a
   * "wildcard" search. This is possible by passing the special value
   * {@link MiniSearch.wildcard} as the query:
   *
   * ```javascript
   * // Return search results for all documents
   * miniSearch.search(MiniSearch.wildcard)
   * ```
   *
   * Note that search options such as `filter` and `boostDocument` are still
   * applied, influencing which results are returned, and their order:
   *
   * ```javascript
   * // Return search results for all documents in the 'fiction' category
   * miniSearch.search(MiniSearch.wildcard, {
   *   filter: (result) => result.category === 'fiction'
   * })
   * ```
   *
   * ### Advanced combination of queries:
   *
   * It is possible to combine different subqueries with OR, AND, and AND_NOT,
   * and even with different search options, by passing a query expression
   * tree object as the first argument, instead of a string.
   *
   * ```javascript
   * // Search for documents that contain "zen" and ("motorcycle" or "archery")
   * miniSearch.search({
   *   combineWith: 'AND',
   *   queries: [
   *     'zen',
   *     {
   *       combineWith: 'OR',
   *       queries: ['motorcycle', 'archery']
   *     }
   *   ]
   * })
   *
   * // Search for documents that contain ("apple" or "pear") but not "juice" and
   * // not "tree"
   * miniSearch.search({
   *   combineWith: 'AND_NOT',
   *   queries: [
   *     {
   *       combineWith: 'OR',
   *       queries: ['apple', 'pear']
   *     },
   *     'juice',
   *     'tree'
   *   ]
   * })
   * ```
   *
   * Each node in the expression tree can be either a string, or an object that
   * supports all {@link SearchOptions} fields, plus a `queries` array field for
   * subqueries.
   *
   * Note that, while this can become complicated to do by hand for complex or
   * deeply nested queries, it provides a formalized expression tree API for
   * external libraries that implement a parser for custom query languages.
   *
   * @param query  Search query
   * @param searchOptions  Search options. Each option, if not given, defaults to the corresponding value of `searchOptions` given to the constructor, or to the library default.
   */
  search(query, searchOptions = {}) {
    const { searchOptions: globalSearchOptions } = this._options;
    const searchOptionsWithDefaults = { ...globalSearchOptions, ...searchOptions };
    const rawResults = this.executeQuery(query, searchOptions);
    const results = [];
    for (const [docId, { score, terms, match }] of rawResults) {
      const quality = terms.length || 1;
      const result = {
        id: this._documentIds.get(docId),
        score: score * quality,
        terms: Object.keys(match),
        queryTerms: terms,
        match
      };
      Object.assign(result, this._storedFields.get(docId));
      if (searchOptionsWithDefaults.filter == null || searchOptionsWithDefaults.filter(result)) {
        results.push(result);
      }
    }
    if (query === _MiniSearch.wildcard && searchOptionsWithDefaults.boostDocument == null) {
      return results;
    }
    results.sort(byScore);
    return results;
  }
  /**
   * Provide suggestions for the given search query
   *
   * The result is a list of suggested modified search queries, derived from the
   * given search query, each with a relevance score, sorted by descending score.
   *
   * By default, it uses the same options used for search, except that by
   * default it performs prefix search on the last term of the query, and
   * combine terms with `'AND'` (requiring all query terms to match). Custom
   * options can be passed as a second argument. Defaults can be changed upon
   * calling the {@link MiniSearch} constructor, by passing a
   * `autoSuggestOptions` option.
   *
   * ### Basic usage:
   *
   * ```javascript
   * // Get suggestions for 'neuro':
   * miniSearch.autoSuggest('neuro')
   * // => [ { suggestion: 'neuromancer', terms: [ 'neuromancer' ], score: 0.46240 } ]
   * ```
   *
   * ### Multiple words:
   *
   * ```javascript
   * // Get suggestions for 'zen ar':
   * miniSearch.autoSuggest('zen ar')
   * // => [
   * //  { suggestion: 'zen archery art', terms: [ 'zen', 'archery', 'art' ], score: 1.73332 },
   * //  { suggestion: 'zen art', terms: [ 'zen', 'art' ], score: 1.21313 }
   * // ]
   * ```
   *
   * ### Fuzzy suggestions:
   *
   * ```javascript
   * // Correct spelling mistakes using fuzzy search:
   * miniSearch.autoSuggest('neromancer', { fuzzy: 0.2 })
   * // => [ { suggestion: 'neuromancer', terms: [ 'neuromancer' ], score: 1.03998 } ]
   * ```
   *
   * ### Filtering:
   *
   * ```javascript
   * // Get suggestions for 'zen ar', but only within the 'fiction' category
   * // (assuming that 'category' is a stored field):
   * miniSearch.autoSuggest('zen ar', {
   *   filter: (result) => result.category === 'fiction'
   * })
   * // => [
   * //  { suggestion: 'zen archery art', terms: [ 'zen', 'archery', 'art' ], score: 1.73332 },
   * //  { suggestion: 'zen art', terms: [ 'zen', 'art' ], score: 1.21313 }
   * // ]
   * ```
   *
   * @param queryString  Query string to be expanded into suggestions
   * @param options  Search options. The supported options and default values
   * are the same as for the {@link MiniSearch#search} method, except that by
   * default prefix search is performed on the last term in the query, and terms
   * are combined with `'AND'`.
   * @return  A sorted array of suggestions sorted by relevance score.
   */
  autoSuggest(queryString, options = {}) {
    options = { ...this._options.autoSuggestOptions, ...options };
    const suggestions = /* @__PURE__ */ new Map();
    for (const { score, terms } of this.search(queryString, options)) {
      const phrase = terms.join(" ");
      const suggestion = suggestions.get(phrase);
      if (suggestion != null) {
        suggestion.score += score;
        suggestion.count += 1;
      } else {
        suggestions.set(phrase, { score, terms, count: 1 });
      }
    }
    const results = [];
    for (const [suggestion, { score, terms, count }] of suggestions) {
      results.push({ suggestion, terms, score: score / count });
    }
    results.sort(byScore);
    return results;
  }
  /**
   * Total number of documents available to search
   */
  get documentCount() {
    return this._documentCount;
  }
  /**
   * Number of terms in the index
   */
  get termCount() {
    return this._index.size;
  }
  /**
   * Deserializes a JSON index (serialized with `JSON.stringify(miniSearch)`)
   * and instantiates a MiniSearch instance. It should be given the same options
   * originally used when serializing the index.
   *
   * ### Usage:
   *
   * ```javascript
   * // If the index was serialized with:
   * let miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * miniSearch.addAll(documents)
   *
   * const json = JSON.stringify(miniSearch)
   * // It can later be deserialized like this:
   * miniSearch = MiniSearch.loadJSON(json, { fields: ['title', 'text'] })
   * ```
   *
   * @param json  JSON-serialized index
   * @param options  configuration options, same as the constructor
   * @return An instance of MiniSearch deserialized from the given JSON.
   */
  static loadJSON(json, options) {
    if (options == null) {
      throw new Error("MiniSearch: loadJSON should be given the same options used when serializing the index");
    }
    return this.loadJS(JSON.parse(json), options);
  }
  /**
   * Async equivalent of {@link MiniSearch.loadJSON}
   *
   * This function is an alternative to {@link MiniSearch.loadJSON} that returns
   * a promise, and loads the index in batches, leaving pauses between them to avoid
   * blocking the main thread. It tends to be slower than the synchronous
   * version, but does not block the main thread, so it can be a better choice
   * when deserializing very large indexes.
   *
   * @param json  JSON-serialized index
   * @param options  configuration options, same as the constructor
   * @return A Promise that will resolve to an instance of MiniSearch deserialized from the given JSON.
   */
  static async loadJSONAsync(json, options) {
    if (options == null) {
      throw new Error("MiniSearch: loadJSON should be given the same options used when serializing the index");
    }
    return this.loadJSAsync(JSON.parse(json), options);
  }
  /**
   * Returns the default value of an option. It will throw an error if no option
   * with the given name exists.
   *
   * @param optionName  Name of the option
   * @return The default value of the given option
   *
   * ### Usage:
   *
   * ```javascript
   * // Get default tokenizer
   * MiniSearch.getDefault('tokenize')
   *
   * // Get default term processor
   * MiniSearch.getDefault('processTerm')
   *
   * // Unknown options will throw an error
   * MiniSearch.getDefault('notExisting')
   * // => throws 'MiniSearch: unknown option "notExisting"'
   * ```
   */
  static getDefault(optionName) {
    if (defaultOptions.hasOwnProperty(optionName)) {
      return getOwnProperty(defaultOptions, optionName);
    } else {
      throw new Error(`MiniSearch: unknown option "${optionName}"`);
    }
  }
  /**
   * @ignore
   */
  static loadJS(js, options) {
    const { index, documentIds, fieldLength, storedFields, serializationVersion } = js;
    const miniSearch = this.instantiateMiniSearch(js, options);
    miniSearch._documentIds = objectToNumericMap(documentIds);
    miniSearch._fieldLength = objectToNumericMap(fieldLength);
    miniSearch._storedFields = objectToNumericMap(storedFields);
    for (const [shortId, id] of miniSearch._documentIds) {
      miniSearch._idToShortId.set(id, shortId);
    }
    for (const [term, data] of index) {
      const dataMap = /* @__PURE__ */ new Map();
      for (const fieldId of Object.keys(data)) {
        let indexEntry = data[fieldId];
        if (serializationVersion === 1) {
          indexEntry = indexEntry.ds;
        }
        dataMap.set(parseInt(fieldId, 10), objectToNumericMap(indexEntry));
      }
      miniSearch._index.set(term, dataMap);
    }
    return miniSearch;
  }
  /**
   * @ignore
   */
  static async loadJSAsync(js, options) {
    const { index, documentIds, fieldLength, storedFields, serializationVersion } = js;
    const miniSearch = this.instantiateMiniSearch(js, options);
    miniSearch._documentIds = await objectToNumericMapAsync(documentIds);
    miniSearch._fieldLength = await objectToNumericMapAsync(fieldLength);
    miniSearch._storedFields = await objectToNumericMapAsync(storedFields);
    for (const [shortId, id] of miniSearch._documentIds) {
      miniSearch._idToShortId.set(id, shortId);
    }
    let count = 0;
    for (const [term, data] of index) {
      const dataMap = /* @__PURE__ */ new Map();
      for (const fieldId of Object.keys(data)) {
        let indexEntry = data[fieldId];
        if (serializationVersion === 1) {
          indexEntry = indexEntry.ds;
        }
        dataMap.set(parseInt(fieldId, 10), await objectToNumericMapAsync(indexEntry));
      }
      if (++count % 1e3 === 0)
        await wait(0);
      miniSearch._index.set(term, dataMap);
    }
    return miniSearch;
  }
  /**
   * @ignore
   */
  static instantiateMiniSearch(js, options) {
    const { documentCount, nextId, fieldIds, averageFieldLength, dirtCount, serializationVersion } = js;
    if (serializationVersion !== 1 && serializationVersion !== 2) {
      throw new Error("MiniSearch: cannot deserialize an index created with an incompatible version");
    }
    const miniSearch = new _MiniSearch(options);
    miniSearch._documentCount = documentCount;
    miniSearch._nextId = nextId;
    miniSearch._idToShortId = /* @__PURE__ */ new Map();
    miniSearch._fieldIds = fieldIds;
    miniSearch._avgFieldLength = averageFieldLength;
    miniSearch._dirtCount = dirtCount || 0;
    miniSearch._index = new SearchableMap();
    return miniSearch;
  }
  /**
   * @ignore
   */
  executeQuery(query, searchOptions = {}) {
    if (query === _MiniSearch.wildcard) {
      return this.executeWildcardQuery(searchOptions);
    }
    if (typeof query !== "string") {
      const options2 = { ...searchOptions, ...query, queries: void 0 };
      const results2 = query.queries.map((subquery) => this.executeQuery(subquery, options2));
      return this.combineResults(results2, options2.combineWith);
    }
    const { tokenize: tokenize2, processTerm: processTerm2, searchOptions: globalSearchOptions } = this._options;
    const options = { tokenize: tokenize2, processTerm: processTerm2, ...globalSearchOptions, ...searchOptions };
    const { tokenize: searchTokenize, processTerm: searchProcessTerm } = options;
    const terms = searchTokenize(query).flatMap((term) => searchProcessTerm(term)).filter((term) => !!term);
    const queries = terms.map(termToQuerySpec(options));
    const results = queries.map((query2) => this.executeQuerySpec(query2, options));
    return this.combineResults(results, options.combineWith);
  }
  /**
   * @ignore
   */
  executeQuerySpec(query, searchOptions) {
    const options = { ...this._options.searchOptions, ...searchOptions };
    const boosts = (options.fields || this._options.fields).reduce((boosts2, field) => ({ ...boosts2, [field]: getOwnProperty(options.boost, field) || 1 }), {});
    const { boostDocument, weights, maxFuzzy, bm25: bm25params } = options;
    const { fuzzy: fuzzyWeight, prefix: prefixWeight } = { ...defaultSearchOptions.weights, ...weights };
    const data = this._index.get(query.term);
    const results = this.termResults(query.term, query.term, 1, query.termBoost, data, boosts, boostDocument, bm25params);
    let prefixMatches;
    let fuzzyMatches;
    if (query.prefix) {
      prefixMatches = this._index.atPrefix(query.term);
    }
    if (query.fuzzy) {
      const fuzzy = query.fuzzy === true ? 0.2 : query.fuzzy;
      const maxDistance = fuzzy < 1 ? Math.min(maxFuzzy, Math.round(query.term.length * fuzzy)) : fuzzy;
      if (maxDistance)
        fuzzyMatches = this._index.fuzzyGet(query.term, maxDistance);
    }
    if (prefixMatches) {
      for (const [term, data2] of prefixMatches) {
        const distance = term.length - query.term.length;
        if (!distance) {
          continue;
        }
        fuzzyMatches === null || fuzzyMatches === void 0 ? void 0 : fuzzyMatches.delete(term);
        const weight = prefixWeight * term.length / (term.length + 0.3 * distance);
        this.termResults(query.term, term, weight, query.termBoost, data2, boosts, boostDocument, bm25params, results);
      }
    }
    if (fuzzyMatches) {
      for (const term of fuzzyMatches.keys()) {
        const [data2, distance] = fuzzyMatches.get(term);
        if (!distance) {
          continue;
        }
        const weight = fuzzyWeight * term.length / (term.length + distance);
        this.termResults(query.term, term, weight, query.termBoost, data2, boosts, boostDocument, bm25params, results);
      }
    }
    return results;
  }
  /**
   * @ignore
   */
  executeWildcardQuery(searchOptions) {
    const results = /* @__PURE__ */ new Map();
    const options = { ...this._options.searchOptions, ...searchOptions };
    for (const [shortId, id] of this._documentIds) {
      const score = options.boostDocument ? options.boostDocument(id, "", this._storedFields.get(shortId)) : 1;
      results.set(shortId, {
        score,
        terms: [],
        match: {}
      });
    }
    return results;
  }
  /**
   * @ignore
   */
  combineResults(results, combineWith = OR) {
    if (results.length === 0) {
      return /* @__PURE__ */ new Map();
    }
    const operator = combineWith.toLowerCase();
    const combinator = combinators[operator];
    if (!combinator) {
      throw new Error(`Invalid combination operator: ${combineWith}`);
    }
    return results.reduce(combinator) || /* @__PURE__ */ new Map();
  }
  /**
   * Allows serialization of the index to JSON, to possibly store it and later
   * deserialize it with {@link MiniSearch.loadJSON}.
   *
   * Normally one does not directly call this method, but rather call the
   * standard JavaScript `JSON.stringify()` passing the {@link MiniSearch}
   * instance, and JavaScript will internally call this method. Upon
   * deserialization, one must pass to {@link MiniSearch.loadJSON} the same
   * options used to create the original instance that was serialized.
   *
   * ### Usage:
   *
   * ```javascript
   * // Serialize the index:
   * let miniSearch = new MiniSearch({ fields: ['title', 'text'] })
   * miniSearch.addAll(documents)
   * const json = JSON.stringify(miniSearch)
   *
   * // Later, to deserialize it:
   * miniSearch = MiniSearch.loadJSON(json, { fields: ['title', 'text'] })
   * ```
   *
   * @return A plain-object serializable representation of the search index.
   */
  toJSON() {
    const index = [];
    for (const [term, fieldIndex] of this._index) {
      const data = {};
      for (const [fieldId, freqs] of fieldIndex) {
        data[fieldId] = Object.fromEntries(freqs);
      }
      index.push([term, data]);
    }
    return {
      documentCount: this._documentCount,
      nextId: this._nextId,
      documentIds: Object.fromEntries(this._documentIds),
      fieldIds: this._fieldIds,
      fieldLength: Object.fromEntries(this._fieldLength),
      averageFieldLength: this._avgFieldLength,
      storedFields: Object.fromEntries(this._storedFields),
      dirtCount: this._dirtCount,
      index,
      serializationVersion: 2
    };
  }
  /**
   * @ignore
   */
  termResults(sourceTerm, derivedTerm, termWeight, termBoost, fieldTermData, fieldBoosts, boostDocumentFn, bm25params, results = /* @__PURE__ */ new Map()) {
    if (fieldTermData == null)
      return results;
    for (const field of Object.keys(fieldBoosts)) {
      const fieldBoost = fieldBoosts[field];
      const fieldId = this._fieldIds[field];
      const fieldTermFreqs = fieldTermData.get(fieldId);
      if (fieldTermFreqs == null)
        continue;
      let matchingFields = fieldTermFreqs.size;
      const avgFieldLength = this._avgFieldLength[fieldId];
      for (const docId of fieldTermFreqs.keys()) {
        if (!this._documentIds.has(docId)) {
          this.removeTerm(fieldId, docId, derivedTerm);
          matchingFields -= 1;
          continue;
        }
        const docBoost = boostDocumentFn ? boostDocumentFn(this._documentIds.get(docId), derivedTerm, this._storedFields.get(docId)) : 1;
        if (!docBoost)
          continue;
        const termFreq = fieldTermFreqs.get(docId);
        const fieldLength = this._fieldLength.get(docId)[fieldId];
        const rawScore = calcBM25Score(termFreq, matchingFields, this._documentCount, fieldLength, avgFieldLength, bm25params);
        const weightedScore = termWeight * termBoost * fieldBoost * docBoost * rawScore;
        const result = results.get(docId);
        if (result) {
          result.score += weightedScore;
          assignUniqueTerm(result.terms, sourceTerm);
          const match = getOwnProperty(result.match, derivedTerm);
          if (match) {
            match.push(field);
          } else {
            result.match[derivedTerm] = [field];
          }
        } else {
          results.set(docId, {
            score: weightedScore,
            terms: [sourceTerm],
            match: { [derivedTerm]: [field] }
          });
        }
      }
    }
    return results;
  }
  /**
   * @ignore
   */
  addTerm(fieldId, documentId, term) {
    const indexData = this._index.fetch(term, createMap);
    let fieldIndex = indexData.get(fieldId);
    if (fieldIndex == null) {
      fieldIndex = /* @__PURE__ */ new Map();
      fieldIndex.set(documentId, 1);
      indexData.set(fieldId, fieldIndex);
    } else {
      const docs = fieldIndex.get(documentId);
      fieldIndex.set(documentId, (docs || 0) + 1);
    }
  }
  /**
   * @ignore
   */
  removeTerm(fieldId, documentId, term) {
    if (!this._index.has(term)) {
      this.warnDocumentChanged(documentId, fieldId, term);
      return;
    }
    const indexData = this._index.fetch(term, createMap);
    const fieldIndex = indexData.get(fieldId);
    if (fieldIndex == null || fieldIndex.get(documentId) == null) {
      this.warnDocumentChanged(documentId, fieldId, term);
    } else if (fieldIndex.get(documentId) <= 1) {
      if (fieldIndex.size <= 1) {
        indexData.delete(fieldId);
      } else {
        fieldIndex.delete(documentId);
      }
    } else {
      fieldIndex.set(documentId, fieldIndex.get(documentId) - 1);
    }
    if (this._index.get(term).size === 0) {
      this._index.delete(term);
    }
  }
  /**
   * @ignore
   */
  warnDocumentChanged(shortDocumentId, fieldId, term) {
    for (const fieldName of Object.keys(this._fieldIds)) {
      if (this._fieldIds[fieldName] === fieldId) {
        this._options.logger("warn", `MiniSearch: document with ID ${this._documentIds.get(shortDocumentId)} has changed before removal: term "${term}" was not present in field "${fieldName}". Removing a document after it has changed can corrupt the index!`, "version_conflict");
        return;
      }
    }
  }
  /**
   * @ignore
   */
  addDocumentId(documentId) {
    const shortDocumentId = this._nextId;
    this._idToShortId.set(documentId, shortDocumentId);
    this._documentIds.set(shortDocumentId, documentId);
    this._documentCount += 1;
    this._nextId += 1;
    return shortDocumentId;
  }
  /**
   * @ignore
   */
  addFields(fields) {
    for (let i = 0; i < fields.length; i++) {
      this._fieldIds[fields[i]] = i;
    }
  }
  /**
   * @ignore
   */
  addFieldLength(documentId, fieldId, count, length) {
    let fieldLengths = this._fieldLength.get(documentId);
    if (fieldLengths == null)
      this._fieldLength.set(documentId, fieldLengths = []);
    fieldLengths[fieldId] = length;
    const averageFieldLength = this._avgFieldLength[fieldId] || 0;
    const totalFieldLength = averageFieldLength * count + length;
    this._avgFieldLength[fieldId] = totalFieldLength / (count + 1);
  }
  /**
   * @ignore
   */
  removeFieldLength(documentId, fieldId, count, length) {
    if (count === 1) {
      this._avgFieldLength[fieldId] = 0;
      return;
    }
    const totalFieldLength = this._avgFieldLength[fieldId] * count - length;
    this._avgFieldLength[fieldId] = totalFieldLength / (count - 1);
  }
  /**
   * @ignore
   */
  saveStoredFields(documentId, doc) {
    const { storeFields, extractField } = this._options;
    if (storeFields == null || storeFields.length === 0) {
      return;
    }
    let documentFields = this._storedFields.get(documentId);
    if (documentFields == null)
      this._storedFields.set(documentId, documentFields = {});
    for (const fieldName of storeFields) {
      const fieldValue = extractField(doc, fieldName);
      if (fieldValue !== void 0)
        documentFields[fieldName] = fieldValue;
    }
  }
};
MiniSearch.wildcard = Symbol("*");
var getOwnProperty = (object, property) => Object.prototype.hasOwnProperty.call(object, property) ? object[property] : void 0;
var combinators = {
  [OR]: (a, b) => {
    for (const docId of b.keys()) {
      const existing = a.get(docId);
      if (existing == null) {
        a.set(docId, b.get(docId));
      } else {
        const { score, terms, match } = b.get(docId);
        existing.score = existing.score + score;
        existing.match = Object.assign(existing.match, match);
        assignUniqueTerms(existing.terms, terms);
      }
    }
    return a;
  },
  [AND]: (a, b) => {
    const combined = /* @__PURE__ */ new Map();
    for (const docId of b.keys()) {
      const existing = a.get(docId);
      if (existing == null)
        continue;
      const { score, terms, match } = b.get(docId);
      assignUniqueTerms(existing.terms, terms);
      combined.set(docId, {
        score: existing.score + score,
        terms: existing.terms,
        match: Object.assign(existing.match, match)
      });
    }
    return combined;
  },
  [AND_NOT]: (a, b) => {
    for (const docId of b.keys())
      a.delete(docId);
    return a;
  }
};
var defaultBM25params = { k: 1.2, b: 0.7, d: 0.5 };
var calcBM25Score = (termFreq, matchingCount, totalCount, fieldLength, avgFieldLength, bm25params) => {
  const { k, b, d } = bm25params;
  const invDocFreq = Math.log(1 + (totalCount - matchingCount + 0.5) / (matchingCount + 0.5));
  return invDocFreq * (d + termFreq * (k + 1) / (termFreq + k * (1 - b + b * fieldLength / avgFieldLength)));
};
var termToQuerySpec = (options) => (term, i, terms) => {
  const fuzzy = typeof options.fuzzy === "function" ? options.fuzzy(term, i, terms) : options.fuzzy || false;
  const prefix = typeof options.prefix === "function" ? options.prefix(term, i, terms) : options.prefix === true;
  const termBoost = typeof options.boostTerm === "function" ? options.boostTerm(term, i, terms) : 1;
  return { term, fuzzy, prefix, termBoost };
};
var defaultOptions = {
  idField: "id",
  extractField: (document, fieldName) => document[fieldName],
  stringifyField: (fieldValue, fieldName) => fieldValue.toString(),
  tokenize: (text) => text.split(SPACE_OR_PUNCTUATION),
  processTerm: (term) => term.toLowerCase(),
  fields: void 0,
  searchOptions: void 0,
  storeFields: [],
  logger: (level, message) => {
    if (typeof (console === null || console === void 0 ? void 0 : console[level]) === "function")
      console[level](message);
  },
  autoVacuum: true
};
var defaultSearchOptions = {
  combineWith: OR,
  prefix: false,
  fuzzy: false,
  maxFuzzy: 6,
  boost: {},
  weights: { fuzzy: 0.45, prefix: 0.375 },
  bm25: defaultBM25params
};
var defaultAutoSuggestOptions = {
  combineWith: AND,
  prefix: (term, i, terms) => i === terms.length - 1
};
var defaultVacuumOptions = { batchSize: 1e3, batchWait: 10 };
var defaultVacuumConditions = { minDirtFactor: 0.1, minDirtCount: 20 };
var defaultAutoVacuumOptions = { ...defaultVacuumOptions, ...defaultVacuumConditions };
var assignUniqueTerm = (target, term) => {
  if (!target.includes(term))
    target.push(term);
};
var assignUniqueTerms = (target, source) => {
  for (const term of source) {
    if (!target.includes(term))
      target.push(term);
  }
};
var byScore = ({ score: a }, { score: b }) => b - a;
var createMap = () => /* @__PURE__ */ new Map();
var objectToNumericMap = (object) => {
  const map = /* @__PURE__ */ new Map();
  for (const key of Object.keys(object)) {
    map.set(parseInt(key, 10), object[key]);
  }
  return map;
};
var objectToNumericMapAsync = async (object) => {
  const map = /* @__PURE__ */ new Map();
  let count = 0;
  for (const key of Object.keys(object)) {
    map.set(parseInt(key, 10), object[key]);
    if (++count % 1e3 === 0) {
      await wait(0);
    }
  }
  return map;
};
var wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
var SPACE_OR_PUNCTUATION = /[\n\r\p{Z}\p{P}]+/u;

// core/text.mjs
var MIN_TOKEN_LENGTH = 3;
var SHORT_ACRONYMS = /* @__PURE__ */ new Set([
  "ai",
  "ml",
  "ui",
  "ux",
  "qa",
  "pr",
  "hr",
  "it",
  "ci",
  "cd",
  "db",
  "api",
  "sdk",
  "gpu"
]);
function isShortAcronym(raw) {
  const letters = String(raw ?? "").replace(/[^\p{L}]+/gu, "");
  if (letters.length < 2 || letters.length > 3) return false;
  if (letters !== letters.toUpperCase()) return false;
  return SHORT_ACRONYMS.has(letters.toLowerCase());
}
var MIN_STEM_LENGTH = 3;
var MAX_STEM_PASSES = 4;
var RAW_STOP_WORDS = [
  // English service words
  "when",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "why",
  "how",
  "should",
  "would",
  "could",
  "can",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "do",
  "does",
  "did",
  "done",
  "is",
  "am",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "then",
  "than",
  "so",
  "such",
  "just",
  "very",
  "also",
  "about",
  "into",
  "over",
  "under",
  "after",
  "before",
  "between",
  "again",
  "more",
  "most",
  "some",
  "any",
  "all",
  "no",
  "not",
  "only",
  "own",
  "same",
  "too",
  "up",
  "down",
  "out",
  "off",
  "i",
  "me",
  "my",
  "we",
  "us",
  "our",
  "you",
  "your",
  "he",
  "she",
  "it",
  "they",
  "them",
  "their",
  "its",
  "and",
  "or",
  "but",
  "if",
  "because",
  "as",
  "at",
  "by",
  "from",
  "in",
  "of",
  "on",
  "to",
  "with",
  "without",
  "next",
  "new",
  "using",
  "use",
  // short English list kept from M5/M6 (a subset check: a, an, the, for …)
  "a",
  "an",
  "the",
  "for",
  // Russian service words (M7 standard list)
  "\u043A\u043E\u0433\u0434\u0430",
  "\u0447\u0442\u043E",
  "\u043A\u0430\u043A\u043E\u0439",
  "\u043A\u0430\u043A\u0438\u0435",
  "\u043A\u0430\u043A",
  "\u043F\u043E\u0447\u0435\u043C\u0443",
  "\u0437\u0430\u0447\u0435\u043C",
  "\u0433\u0434\u0435",
  "\u043A\u0442\u043E",
  "\u0447\u0442\u043E\u0431\u044B",
  "\u0435\u0441\u043B\u0438",
  "\u0438\u043B\u0438",
  "\u043D\u043E",
  "\u0430",
  "\u0436\u0435",
  "\u043B\u0438",
  "\u0431\u044B",
  "\u0434\u043B\u044F",
  "\u043F\u0440\u0438",
  "\u0431\u0435\u0437",
  "\u043F\u043E\u0434",
  "\u043D\u0430\u0434",
  "\u043F\u0440\u043E",
  "\u0447\u0435\u0440\u0435\u0437",
  "\u043C\u0435\u0436\u0434\u0443",
  "\u043F\u043E\u0441\u043B\u0435",
  "\u043F\u0435\u0440\u0435\u0434",
  "\u0442\u0430\u043A\u0436\u0435",
  "\u0443\u0436\u0435",
  "\u0435\u0449\u0435",
  "\u043E\u0447\u0435\u043D\u044C",
  "\u0442\u043E\u043B\u044C\u043A\u043E",
  "\u043D\u0430\u0434\u043E",
  "\u043D\u0443\u0436\u043D\u043E",
  "\u043C\u043E\u0436\u043D\u043E",
  "\u0435\u0441\u0442\u044C",
  "\u0431\u044B\u043B",
  "\u0431\u044B\u043B\u0430",
  "\u0431\u044B\u043B\u043E",
  "\u0431\u044B\u043B\u0438",
  "\u0431\u0443\u0434\u0435\u0442",
  "\u044D\u0442\u043E\u0442",
  "\u044D\u0442\u0430",
  "\u044D\u0442\u043E",
  "\u044D\u0442\u0438",
  "\u0442\u043E\u0442",
  "\u0442\u0430",
  "\u0442\u043E",
  "\u0442\u0435",
  "\u043C\u043E\u0439",
  "\u043C\u043E\u044F",
  "\u043C\u043E\u0451",
  "\u043C\u043E\u0438",
  "\u043D\u0430\u0448",
  "\u043D\u0430\u0448\u0430",
  "\u043D\u0430\u0448\u0435",
  "\u043D\u0430\u0448\u0438",
  "\u0441\u0432\u043E\u0439",
  "\u0441\u0432\u043E\u044F",
  "\u0441\u0432\u043E\u0438",
  "\u0441\u0430\u043C\u044B\u0439",
  // short Russian list kept from M5/M6 (и, в, во, на, по, с, со, к, о, об,
  // от, до, за, из, не) — none of them is in the M7 list above
  "\u0438",
  "\u0432",
  "\u0432\u043E",
  "\u043D\u0430",
  "\u043F\u043E",
  "\u0441",
  "\u0441\u043E",
  "\u043A",
  "\u043E",
  "\u043E\u0431",
  "\u043E\u0442",
  "\u0434\u043E",
  "\u0437\u0430",
  "\u0438\u0437",
  "\u043D\u0435",
  // v0.2 request verbs (owner-approved 26.10.2026): words that only ASK for
  // an action carry no topic — «запусти посмотри попробуй» must prove nothing.
  // SUBJECT verbs stay significant on purpose: проверь/проверить/проверка,
  // аудит, review (they correlate with the topic and already work).
  // "можно"/"нужно"/"надо"/"бы"/"еще" are already listed above (M7).
  "\u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C",
  "\u0437\u0430\u043F\u0443\u0441\u0442\u0438",
  "\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0439",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0435\u0442\u044C",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438",
  "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438\u043C",
  "\u0433\u043B\u044F\u043D\u0443\u0442\u044C",
  "\u0433\u043B\u044F\u043D\u044C",
  "\u043F\u043E\u043F\u0440\u043E\u0431\u043E\u0432\u0430\u0442\u044C",
  "\u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439",
  "\u043F\u0440\u043E\u0433\u043D\u0430\u0442\u044C",
  "\u043F\u0440\u043E\u0433\u043E\u043D\u0438",
  "\u043F\u0440\u043E\u0433\u043E\u043D\u044F\u0439",
  "\u0441\u0434\u0435\u043B\u0430\u0442\u044C",
  "\u0441\u0434\u0435\u043B\u0430\u0439",
  "\u043F\u043E\u043C\u043E\u0447\u044C",
  "\u043F\u043E\u043C\u043E\u0433\u0438",
  "\u043F\u043E\u0434\u0441\u043A\u0430\u0437\u0430\u0442\u044C",
  "\u043F\u043E\u0434\u0441\u043A\u0430\u0436\u0438",
  "\u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C",
  "\u043F\u043E\u043A\u0430\u0436\u0438",
  "\u043D\u0430\u0439\u0442\u0438",
  "\u043D\u0430\u0439\u0434\u0438",
  "\u043C\u043E\u0436\u0435\u0448\u044C",
  "\u0434\u0430\u0432\u0430\u0439",
  "\u043F\u043B\u0438\u0437",
  "\u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430",
  "\u0445\u043E\u0447\u0443",
  "\u0445\u043E\u0442\u0435\u043B",
  "\u0441\u0430\u043C",
  "\u0441\u0430\u043C\u0430",
  "\u0441\u0430\u043C\u043E"
];
var STOP_WORDS = new Set(RAW_STOP_WORDS.map((w) => normalizeTerm(w)));
var RU_SUFFIXES = [
  "\u0430\u043C\u0438",
  "\u044F\u043C\u0438",
  "\u043E\u0432",
  "\u0435\u0432",
  "\u0438\u0439",
  "\u044B\u0439",
  "\u0430\u044F",
  "\u043E\u0435",
  "\u044B\u0435",
  "\u043E\u0439",
  "\u0435\u0439",
  "\u0430\u043C",
  "\u044F\u043C",
  "\u0430\u0445",
  "\u044F\u0445",
  "\u0438",
  "\u044B",
  "\u0430",
  "\u044F",
  "\u043E",
  "\u0435",
  "\u0443",
  "\u044E"
].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
var EN_SUFFIXES = ["ing", "es", "ed", "s"];
var CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
var CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
function isCjkToken(token) {
  return CJK_CHAR_RE.test(String(token ?? ""));
}
var SEGMENTER_CACHE = /* @__PURE__ */ new Map();
function localeForRun(run) {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) return "ja";
  if (/[\p{Script=Hangul}]/u.test(run)) return "ko";
  if (/[\p{Script=Thai}]/u.test(run)) return "th";
  if (/[\p{Script=Lao}]/u.test(run)) return "lo";
  if (/[\p{Script=Khmer}]/u.test(run)) return "km";
  if (/[\p{Script=Myanmar}]/u.test(run)) return "my";
  return "zh";
}
function segmentRun(run) {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return null;
  const locale = localeForRun(run);
  let segmenter = SEGMENTER_CACHE.get(locale);
  if (segmenter === void 0) {
    try {
      segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    } catch {
      segmenter = null;
    }
    SEGMENTER_CACHE.set(locale, segmenter);
  }
  if (segmenter === null) return null;
  try {
    const parts = [];
    for (const { segment } of segmenter.segment(run)) {
      if (segment !== "") parts.push(segment);
    }
    return parts;
  } catch {
    return null;
  }
}
function emitCjkRun(out2, run, seen) {
  const emit = (t) => {
    if (t === "" || seen.has(t)) return;
    seen.add(t);
    out2.push(t);
  };
  const segments = segmentRun(run);
  if (segments) for (const seg of segments) emit(seg);
  if (run.length === 1) {
    emit(run);
    return;
  }
  for (let i = 0; i + 1 < run.length; i += 1) emit(run.slice(i, i + 2));
}
function pushPlainWords(out2, piece) {
  if (piece === "") return;
  for (const t of piece.split(/[^\p{L}\p{N}.]+/u)) {
    if (t !== "" && /[\p{L}\p{N}]/u.test(t)) out2.push(t);
  }
}
function tokenize(text) {
  const s = String(text ?? "");
  const out2 = [];
  const seenCjk = /* @__PURE__ */ new Set();
  let last2 = 0;
  for (const m of s.matchAll(CJK_RUN_RE)) {
    pushPlainWords(out2, s.slice(last2, m.index));
    emitCjkRun(out2, m[0], seenCjk);
    last2 = m.index + m[0].length;
  }
  pushPlainWords(out2, s.slice(last2));
  return out2;
}
function normalizeTerm(raw) {
  let t = String(raw ?? "").toLowerCase();
  t = t.replace(/ё/g, "\u0435");
  t = t.replace(/[^\p{L}\p{N}]+/gu, "");
  return t;
}
function cutEnding(term, suffixes) {
  for (const suffix of suffixes) {
    if (term.length > suffix.length && term.endsWith(suffix)) {
      const stem = term.slice(0, term.length - suffix.length);
      if (stem.length >= MIN_STEM_LENGTH) return stem;
    }
  }
  return null;
}
function stemTerm(term) {
  let current = term;
  for (let pass = 0; pass < MAX_STEM_PASSES; pass += 1) {
    const ru = cutEnding(current, RU_SUFFIXES);
    if (ru) {
      current = ru;
      continue;
    }
    const en = cutEnding(current, EN_SUFFIXES);
    if (en) {
      current = en;
      continue;
    }
    break;
  }
  return current;
}
function processTerm(term) {
  const norm = normalizeTerm(term);
  if (norm === "") return null;
  const stem = stemTerm(norm);
  return stem === "" ? null : stem;
}
function significantQueryTokens(text) {
  const seen = /* @__PURE__ */ new Set();
  const out2 = [];
  for (const raw of tokenize(text)) {
    const acronym = isShortAcronym(raw);
    const norm = normalizeTerm(raw);
    const cjk = isCjkToken(norm);
    if (cjk) {
      if (norm.length < 2) continue;
    } else {
      if (!acronym && norm.length < MIN_TOKEN_LENGTH) continue;
    }
    if (!acronym && STOP_WORDS.has(norm)) continue;
    const stem = stemTerm(norm);
    if (!cjk && !acronym && stem.length < MIN_TOKEN_LENGTH) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    out2.push(stem);
  }
  return out2;
}

// core/index.mjs
var WHY_LIMIT = 160;
var WHY_TERMS_LIMIT = 6;
var FIELD_BOOST = { name: 3, description: 2, headings: 1, aliases: 1 };
var LEXICON_PATH = fileURLToPath(new URL("./lexicon.ru-en.json", import.meta.url));
var WEAK_KEY = "_weak";
var lexiconCache = null;
function loadLexicon() {
  if (lexiconCache) return lexiconCache;
  let map = /* @__PURE__ */ new Map();
  try {
    const raw = JSON.parse(fs2.readFileSync(LEXICON_PATH, "utf8"));
    const weakKeys = new Set(
      (Array.isArray(raw[WEAK_KEY]) ? raw[WEAK_KEY] : []).filter((k) => typeof k === "string")
    );
    for (const [ru, ens] of Object.entries(raw)) {
      if (ru === WEAK_KEY) continue;
      if (!Array.isArray(ens)) continue;
      const ruKey = processTerm(ru);
      const weak = weakKeys.has(ru);
      for (const en of ens) {
        if (typeof en !== "string" || !en) continue;
        if (ruKey) addUnique(map, ruKey, en.toLowerCase(), weak);
        for (const tok of tokenize(en)) {
          const enKey = processTerm(tok);
          if (!enKey || enKey.length < 3 || STOP_WORDS.has(enKey)) continue;
          addUnique(map, enKey, ru.toLowerCase(), weak);
        }
      }
    }
  } catch {
    map = /* @__PURE__ */ new Map();
  }
  lexiconCache = map;
  return map;
}
function addUnique(map, key, value, weak) {
  const list = map.get(key);
  if (!list) {
    map.set(key, [{ term: value, weak }]);
    return;
  }
  const found = list.find((e) => e.term === value);
  if (!found) list.push({ term: value, weak });
  else if (found.weak && !weak) found.weak = false;
}
function buildAliases(text) {
  const lex = loadLexicon();
  if (lex.size === 0) return { all: "", strong: [] };
  const found = /* @__PURE__ */ new Set();
  const strong = /* @__PURE__ */ new Set();
  for (const raw of tokenize(text)) {
    const key = processTerm(raw);
    if (!key) continue;
    const hit = lex.get(key);
    if (!hit) continue;
    for (const e of hit) {
      found.add(e.term);
      if (e.weak) continue;
      for (const tok of tokenize(e.term)) {
        const stem = processTerm(tok);
        if (stem) strong.add(stem);
      }
    }
  }
  return { all: [...found].join(" "), strong: [...strong] };
}
var hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
var MIN_COVERAGE = 2;
function significantTerms(terms) {
  const out2 = [];
  for (const raw of terms) {
    const t = String(raw).toLowerCase().trim();
    if (t.length <= 1) continue;
    if (STOP_WORDS.has(t)) continue;
    out2.push(t);
  }
  return out2;
}
function buildIndex(skills) {
  const index = new MiniSearch({
    fields: ["name", "description", "headings", "aliases"],
    storeFields: ["name", "path", "description", "headings", "cover"],
    tokenize,
    processTerm,
    bm25: { k: 1.2, b: 0.7 }
  });
  const docs = skills.map((s, i) => {
    const text = [s.name, s.description || "", (s.bodyHeadings || []).join(" ")].join(" ");
    const aliases = buildAliases(text);
    const cover = /* @__PURE__ */ new Set();
    for (const raw of tokenize(text)) {
      const t = processTerm(raw);
      if (t) cover.add(t);
    }
    for (const t of aliases.strong) cover.add(t);
    return {
      id: s.path || `skill-${i}`,
      name: s.name,
      path: s.path,
      description: s.description || "",
      headings: Array.isArray(s.bodyHeadings) ? s.bodyHeadings.join(" ") : "",
      aliases: aliases.all,
      cover: [...cover]
    };
  });
  index.addAll(docs);
  return index;
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function nameMatches(name, pattern) {
  const lower = String(name).toLowerCase();
  if (pattern.includes("*")) {
    const rx = new RegExp(`^${escapeRegex(pattern).replace(/\\\*/g, ".*")}$`, "i");
    return rx.test(name);
  }
  return lower === String(pattern).toLowerCase();
}
function makeFilter(restrictTo) {
  return (result) => restrictTo.some((p) => nameMatches(result.name, p));
}
function buildWhy(result) {
  const terms = significantTerms(result.terms || []).slice(0, WHY_TERMS_LIMIT);
  const wanted = new Set(terms);
  const fieldHolds = (text) => {
    if (wanted.size === 0) return false;
    for (const raw of tokenize(text)) {
      const term = processTerm(raw);
      if (term !== null && wanted.has(term)) return true;
    }
    return false;
  };
  const haystacks = [
    ["name", String(result.name || "")],
    ["description", String(result.description || "")],
    ["headings", String(result.headings || "")]
  ];
  const fields = haystacks.filter(([, text]) => fieldHolds(text)).map(([field]) => field);
  let why;
  if (terms.length > 0) {
    why = fields.length ? `matched ${fields.join("+")}: ${terms.join(", ")}` : `matched keywords: ${terms.join(", ")}`;
  } else {
    why = "matched keywords";
  }
  why = why.replace(/\s+/g, " ").trim();
  if (why.length > WHY_LIMIT) why = `${why.slice(0, WHY_LIMIT - 3)}...`;
  return why;
}
function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}
function compareByScoreThenPath(a, b) {
  const sa = Number.isFinite(a && a.score) ? a.score : -Infinity;
  const sb = Number.isFinite(b && b.score) ? b.score : -Infinity;
  if (sa !== sb) return sb - sa;
  const pa = String(a && a.path || "");
  const pb = String(b && b.path || "");
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}
function dedupeByName(results) {
  const best = /* @__PURE__ */ new Map();
  for (const r of results) {
    const prev = best.get(r.name);
    if (prev === void 0 || compareByScoreThenPath(r, prev) < 0) best.set(r.name, r);
  }
  const emitted = /* @__PURE__ */ new Set();
  const out2 = [];
  for (const r of results) {
    if (emitted.has(r.name)) continue;
    emitted.add(r.name);
    out2.push(best.get(r.name));
  }
  return out2;
}
var BOOST_TRIGGER = /(описан|текст|лендинг|копирайт|продукт)/iu;
var BOOST_ORDER = [
  "promo",
  "copywriting",
  "site-copywriting",
  "app-copywriting",
  "documentation-and-adrs",
  "redpolitika"
];
function expandQuery(query) {
  let expanded = query;
  if (/описан|опиш/iu.test(query)) expanded += " \u0442\u0435\u043A\u0441\u0442";
  if (/продукт/iu.test(query)) expanded += " product";
  return expanded;
}
function boostReorder(hits) {
  if (!Array.isArray(hits)) return [];
  const byName = /* @__PURE__ */ new Map();
  for (const h of hits) if (h && typeof h.name === "string" && !byName.has(h.name)) byName.set(h.name, h);
  const out2 = [];
  for (const name of BOOST_ORDER) {
    const hit = byName.get(name);
    if (hit) out2.push(hit);
  }
  const used = new Set(out2.map((h) => h.name));
  for (const h of hits) if (!used.has(h.name)) out2.push(h);
  return out2;
}
function search(index, query, { limit = 5, restrict_to: restrictTo, boost } = {}) {
  if (typeof query !== "string") return [];
  const q = query.trim();
  if (!q) return [];
  if (!/[\p{L}\p{N}]/u.test(q)) return [];
  const expanded = expandQuery(q);
  const sig = significantQueryTokens(expanded);
  if (sig.length === 0) return [];
  const options = { boost: boost ? { ...boost } : { ...FIELD_BOOST } };
  if (Array.isArray(restrictTo) && restrictTo.length > 0) {
    options.filter = makeFilter(restrictTo);
  }
  const matched = index.search(expanded, options);
  const need = sig.length <= 2 ? 1 : Math.min(MIN_COVERAGE, sig.length);
  const withConfidence = matched.map((r) => {
    const cover = Array.isArray(r.cover) ? new Set(r.cover) : null;
    const match = r.match || null;
    if (!cover && !match) return { result: r, confident: false };
    let count = 0;
    for (const t of sig) {
      const hit = cover ? cover.has(t) : hasOwn(match, t);
      if (hit) count += 1;
      if (count >= need) return { result: r, confident: true };
    }
    return { result: r, confident: false };
  });
  withConfidence.sort((a, b) => {
    if (a.confident !== b.confident) return a.confident ? -1 : 1;
    return compareResults(a.result, b.result);
  });
  const unique = dedupeByName(withConfidence.map((e) => ({ ...e.result, confident: e.confident })));
  const capped = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), unique.length) : unique.length;
  const results = unique.slice(0, capped).map((r) => ({
    name: r.name,
    path: r.path,
    score: r.score,
    why: buildWhy(r),
    description: r.description || "",
    confident: r.confident === true
  }));
  return BOOST_TRIGGER.test(q) ? boostReorder(results) : results;
}

// plugin/hint.mjs
import os2 from "node:os";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var HINT_SOURCE = "skill-mcp";
var HINT_NOTE = "\u043F\u043E\u0441\u043C\u043E\u0442\u0440\u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u044F \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432; \u0435\u0441\u043B\u0438 \u043E\u0434\u0438\u043D \u043F\u043E\u0434\u0445\u043E\u0434\u0438\u0442 \u2014 \u0437\u0430\u0433\u0440\u0443\u0437\u0438 \u0435\u0433\u043E \u0447\u0435\u0440\u0435\u0437 skill; \u0435\u0441\u043B\u0438 \u043D\u0435\u0442 \u2014 \u043D\u0435 \u0437\u0430\u0433\u0440\u0443\u0436\u0430\u0439.";
var HINT_TAG = `<skill_hint source="${HINT_SOURCE}" note="${HINT_NOTE}">`;
var HINT_MARKER = `<skill_hint source="${HINT_SOURCE}"`;
var RULE_MARKER = "<skill_router_rule>";
var ROUTER_RULE = [
  RULE_MARKER,
  "\u041F\u0435\u0440\u0432\u043E\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435 \u0432 \u0437\u0430\u0434\u0430\u0447\u0435 \u2014 \u0432\u044B\u0437\u043E\u0432\u0438 find \u0441\u0435\u0440\u0432\u0435\u0440\u0430 skill-mcp \u0441 \u0437\u0430\u043F\u0440\u043E\u0441\u043E\u043C \u0438\u0437 \u0437\u0430\u0434\u0430\u0447\u0438. \u0414\u043E \u044D\u0442\u043E\u0433\u043E \u043D\u0435 \u043D\u0430\u0447\u0438\u043D\u0430\u0439 \u043F\u0440\u0430\u0432\u043A\u0438, \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u0438 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043E\u0442\u0432\u0435\u0442\u044B. \u0415\u0441\u043B\u0438 \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442 \u043F\u043E\u0434\u0445\u043E\u0434\u0438\u0442 \u2014 \u0437\u0430\u0433\u0440\u0443\u0437\u0438 \u0435\u0433\u043E \u0447\u0435\u0440\u0435\u0437 skill; \u0441\u043A\u0440\u044B\u0442\u044B\u0435 \u0438\u0437 \u043A\u0430\u0442\u0430\u043B\u043E\u0433\u0430 \u0441\u043A\u0438\u043B\u043B\u044B \u0442\u043E\u0436\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B \u0447\u0435\u0440\u0435\u0437 find. \u041D\u0435\u0442 \u0431\u043B\u043E\u043A\u0430 <skill_hint> \u2014 \u0437\u043D\u0430\u0447\u0438\u0442 \xAB\u0430\u0432\u0442\u043E\u0441\u043E\u0432\u043F\u0430\u0434\u0435\u043D\u0438\u044F \u043D\u0435\u0442\xBB, \u0430 \u043D\u0435 \xAB\u0441\u043A\u0438\u043B\u043B\u043E\u0432 \u043D\u0435\u0442\xBB: \u043F\u0440\u043E\u0432\u0435\u0440\u044C \u0441\u0430\u043C. \u041F\u0440\u043E\u043F\u0443\u0441\u043A = \u0437\u0430\u0434\u0430\u0447\u0430 \u043D\u0435 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D\u0430.",
  "</skill_router_rule>"
].join("\n");
var LETTERS_RE = new RegExp("\\p{L}", "u");
var HERE = path2.dirname(fileURLToPath2(import.meta.url));
var DEFAULT_CONFIG_PATH = path2.join(os2.homedir(), ".config", "opencode", "skill-mcp.config.json");
var MODULE_CONFIG_PATH = path2.join(HERE, "skill-mcp.config.json");

// cli/main.mjs
var HERE2 = path3.dirname(fileURLToPath3(import.meta.url));
var PKG_ROOT = path3.dirname(HERE2);
var SERVER_PATH = path3.join(PKG_ROOT, "dist", "server.mjs");
var PLUGIN_DIR = path3.join(PKG_ROOT, "dist", "plugin");
var PKG = (() => {
  try {
    return JSON.parse(fs3.readFileSync(path3.join(PKG_ROOT, "package.json"), "utf8"));
  } catch {
    return { name: "skill-finder-mcp", version: "0.0.0" };
  }
})();
var MCP_KEY = "skill-mcp";
var FMT = { insertSpaces: true, tabSize: 2, eol: "\n" };
function out(...a) {
  process.stdout.write(`${a.join(" ")}
`);
}
function err(...a) {
  process.stderr.write(`${a.join(" ")}
`);
}
function parseArgs(argv) {
  const args = { _: [], config: null, dryRun: false, yes: false, uninstall: false, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--config") {
      args.config = argv[i + 1] ?? null;
      i += 1;
      if (!args.config) throw new Error("--config requires a path");
    } else if (a.startsWith("--config=")) {
      args.config = a.slice("--config=".length);
      if (!args.config) throw new Error("--config requires a path");
    } else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--yes" || a === "-y") args.yes = true;
    else if (a === "--uninstall") args.uninstall = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else if (a.startsWith("-")) throw new Error(`unknown option: ${a}`);
    else args._.push(a);
  }
  return args;
}
function globalConfigCandidates() {
  const base = path3.join(os3.homedir(), ".config", "opencode");
  return [path3.join(base, "opencode.jsonc"), path3.join(base, "opencode.json")];
}
function resolveConfigPath(explicit) {
  if (explicit) return { path: path3.resolve(explicit), exists: fs3.existsSync(path3.resolve(explicit)), created: false };
  const cands = globalConfigCandidates();
  for (const c of cands) {
    if (fs3.existsSync(c)) return { path: c, exists: true, created: false };
  }
  return { path: cands[0], exists: false, created: true };
}
function readConfig(text, file) {
  const errors = [];
  const value = parse2(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const e = errors[0];
    const line = text.slice(0, e.offset).split(/\r?\n/).length;
    throw new Error(`${file}: invalid JSONC at line ${line} (offset ${e.offset}, error code ${e.error}) \u2014 fix it or pass --config <path>`);
  }
  if (value === void 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: top-level JSON value must be an object`);
  }
  return value;
}
function edit(text, editPath, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(text, editPath, value, { formattingOptions: { ...FMT, eol } });
  return applyEdits(text, edits);
}
function diffLines(before, after) {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = `  (${start} unchanged leading line(s), ${a.length - endA} unchanged trailing line(s) omitted)`;
  const body = [];
  for (let i = start; i < endA; i += 1) body.push(`- ${a[i]}`);
  for (let i = start; i < endB; i += 1) body.push(`+ ${b[i]}`);
  if (body.length === 0) return "(no changes)";
  return [head, ...body].join("\n");
}
function backupName(file) {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${file}.bak-${stamp}`;
}
function seedText() {
  return '{\n  // skill-mcp installer (npx skill-finder-mcp init)\n  "$schema": "https://opencode.ai/config.json"\n}\n';
}
function desiredMcpEntry() {
  return { type: "local", command: ["node", SERVER_PATH], enabled: true };
}
function applyInit(text) {
  let next = text;
  next = edit(next, ["mcp", MCP_KEY], desiredMcpEntry());
  const cur = parse2(next, [], { allowTrailingComma: true });
  const plugins = Array.isArray(cur.plugins) ? cur.plugins : [];
  if (!plugins.includes(PLUGIN_DIR)) {
    if (Array.isArray(cur.plugins)) {
      next = edit(next, ["plugins", plugins.length], PLUGIN_DIR);
    } else {
      next = edit(next, ["plugins"], [PLUGIN_DIR]);
    }
  }
  return next;
}
function applyUninstall(text) {
  let next = text;
  const cur = parse2(next, [], { allowTrailingComma: true });
  if (cur && cur.mcp && Object.prototype.hasOwnProperty.call(cur.mcp, MCP_KEY)) {
    next = edit(next, ["mcp", MCP_KEY], void 0);
  }
  const plugins = cur && Array.isArray(cur.plugins) ? cur.plugins : [];
  const idx = plugins.indexOf(PLUGIN_DIR);
  if (idx >= 0) next = edit(next, ["plugins", idx], void 0);
  return next;
}
function cmdInit(args) {
  const target = resolveConfigPath(args.config);
  const exists = fs3.existsSync(target.path);
  const original = exists ? fs3.readFileSync(target.path, "utf8") : seedText();
  const parsedValue = exists ? readConfig(original, target.path) : {};
  const alreadyMcp = parsedValue.mcp && parsedValue.mcp[MCP_KEY] && JSON.stringify(parsedValue.mcp[MCP_KEY]) === JSON.stringify(desiredMcpEntry());
  const alreadyPlugin = Array.isArray(parsedValue.plugins) && parsedValue.plugins.includes(PLUGIN_DIR);
  if (args.uninstall) {
    const next2 = applyUninstall(original);
    if (next2 === original) {
      out(`skill-mcp: not configured in ${target.path} \u2014 nothing to uninstall.`);
      return 0;
    }
    return finishWrite(args, target.path, original, next2, "uninstall");
  }
  if (alreadyMcp && alreadyPlugin) {
    out(`skill-mcp: already configured in ${target.path}.`);
    out(`  mcp.${MCP_KEY}.command[1] = ${SERVER_PATH}`);
    out(`  plugins += ${PLUGIN_DIR}`);
    out("Restart opencode to apply (config is read once at startup).");
    return 0;
  }
  const next = applyInit(original);
  if (next === original) {
    out(`skill-mcp: no change needed in ${target.path}.`);
    return 0;
  }
  return finishWrite(args, target.path, original, next, "install");
}
function finishWrite(args, file, original, next, verb) {
  out(`skill-mcp ${verb}: ${file}`);
  out("diff (before \u2192 after):");
  out(diffLines(original, next));
  out(`  server: ${SERVER_PATH}`);
  out(`  plugin: ${PLUGIN_DIR}`);
  if (args.dryRun) {
    out("dry-run: no file written, no backup made.");
    return 0;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) {
      err("skill-mcp: non-interactive terminal \u2014 pass --yes to apply, or --dry-run to preview.");
      return 1;
    }
    const answer = promptSync(`Apply these changes? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      out("aborted: nothing written.");
      return 1;
    }
  }
  if (fs3.existsSync(file)) {
    const bak = backupName(file);
    fs3.copyFileSync(file, bak);
    out(`backup: ${bak}`);
  }
  fs3.mkdirSync(path3.dirname(file), { recursive: true });
  fs3.writeFileSync(file, next, "utf8");
  out(`written: ${file}`);
  out("Restart opencode to apply (config is read once at startup).");
  return 0;
}
function promptSync(question) {
  fs3.writeSync(2, question);
  try {
    const fd = fs3.openSync("/dev/tty", "rs");
    const buf = Buffer.alloc(1);
    let line = "";
    while (true) {
      const n = fs3.readSync(fd, buf, 0, 1, null);
      if (n === 0 || buf[0] === 10) break;
      line += String(buf[0]);
    }
    fs3.closeSync(fd);
    return line;
  } catch {
    return "";
  }
}
function cmdDoctor(args) {
  const target = resolveConfigPath(args.config);
  const rows = [];
  let ok = true;
  const check = (pass, label, detail) => {
    rows.push(`${pass ? "\u2714" : "\u2716"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!pass) ok = false;
  };
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20, "node >= 20", process.version);
  const exists = fs3.existsSync(target.path);
  rows.push(`\u2139 config: ${target.path}${exists ? "" : " (missing)"}`);
  let cfg = {};
  if (exists) {
    try {
      cfg = readConfig(fs3.readFileSync(target.path, "utf8"), target.path);
    } catch (e) {
      check(false, "config parses", e.message);
    }
  }
  const mcpEntry = cfg.mcp && cfg.mcp[MCP_KEY];
  check(!!mcpEntry, `mcp.${MCP_KEY} present`, mcpEntry ? JSON.stringify(mcpEntry.command) : "add it: skill-mcp init");
  if (mcpEntry && Array.isArray(mcpEntry.command)) {
    const srv = mcpEntry.command[1];
    check(fs3.existsSync(srv), "mcp server file exists", srv);
  }
  const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];
  const isSkillMcpPlugin = (p) => typeof p === "string" && (/[\\/]dist[\\/]plugin$/.test(p) || p.includes("skill-mcp"));
  const pluginDir = plugins.find(isSkillMcpPlugin);
  check(!!pluginDir, "plugins entry present", pluginDir ?? "add it: skill-mcp init");
  if (pluginDir) {
    check(fs3.existsSync(path3.join(pluginDir, "index.mjs")), "plugin directory has index.mjs", pluginDir);
  }
  let roots = [];
  let indexed = 0;
  try {
    roots = defaultRoots();
    const { skills } = discoverSkills(roots);
    indexed = skills.length;
    check(roots.length > 0, "skill roots found", `${roots.length} root(s)`);
    check(indexed > 0, "skills indexed", `${indexed} SKILL.md`);
    if (indexed > 0) {
      const index = buildIndex(skills);
      const hits = search(index, "review a commercial contract", { limit: 5 });
      const names = hits.map((h) => h.name).join(", ") || "(none)";
      rows.push(`\u2139 probe search top-5: ${names}`);
    }
  } catch (e) {
    check(false, "skill discovery", e.message);
  }
  rows.push(`\u2139 plugin config: ${DEFAULT_CONFIG_PATH}${fs3.existsSync(DEFAULT_CONFIG_PATH) ? "" : " (missing \u2192 defaults)"}`);
  const envs = Object.keys(process.env).filter((k) => k.startsWith("SKILL_MCP_"));
  rows.push(`\u2139 env SKILL_MCP_*: ${envs.length ? envs.map((k) => `${k}=${process.env[k]}`).join(", ") : "(none)"}`);
  let ocVersion = null;
  try {
    ocVersion = execFileSync("opencode", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    ocVersion = null;
  }
  rows.push(`${ocVersion ? "\u2139" : "\u26A0"} opencode: ${ocVersion ?? "not found on PATH (install opencode to use skill-mcp)"}`);
  for (const r of rows) out(r);
  out(ok ? "doctor: OK" : "doctor: problems found (see \u2716 above)");
  return ok ? 0 : 1;
}
async function cmdServe() {
  const candidates = [path3.join(HERE2, "server.mjs"), path3.join(HERE2, "..", "server", "index.mjs")];
  for (const c of candidates) {
    if (fs3.existsSync(c)) {
      await import(pathToFileURL(c).href);
      return 0;
    }
  }
  throw new Error("skill-mcp: server bundle not found (run `npm run build`)");
}
var HELP = `skill-mcp ${PKG.version} \u2014 local skill search for opencode (no network, no LLM)

Usage:
  skill-mcp init [--config <path>] [--dry-run] [--yes] [--uninstall]
      Add mcp.${MCP_KEY} + the plugin to an opencode config (JSONC, comments kept).
      Makes a .bak-YYYYMMDD-HHMM backup and shows a diff. Idempotent.
        --config <path>   config file to edit (default: ~/.config/opencode/opencode.jsonc, else .json)
        --dry-run         show the diff, write nothing
        --yes             apply without an interactive prompt
        --uninstall       remove the mcp entry and plugin from the config

  skill-mcp doctor [--config <path>]
      Check node, config, mcp/plugin entries, skill roots, an index probe and env. Exit 0 = OK.

  skill-mcp serve
      Run the MCP server on stdio (normally started by opencode, not by hand).

  skill-mcp --help | --version
`;
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    out(HELP);
    return 0;
  }
  if (args.version) {
    out(PKG.version);
    return 0;
  }
  const cmd = args._[0];
  if (cmd === "init") return cmdInit(args);
  if (cmd === "doctor") return cmdDoctor(args);
  if (cmd === "serve") return cmdServe();
  if (!cmd) {
    out(HELP);
    return 0;
  }
  err(`skill-mcp: unknown command "${cmd}". Run skill-mcp --help.`);
  return 1;
}
main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  },
  (e) => {
    err(`skill-mcp: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
);
