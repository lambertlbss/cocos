/*! Bundled pngjs 7.0.0
pngjs original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/pngjs/lib/chunkstream.js
var require_chunkstream = __commonJS({
  "node_modules/pngjs/lib/chunkstream.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var ChunkStream = module2.exports = function() {
      Stream.call(this);
      this._buffers = [];
      this._buffered = 0;
      this._reads = [];
      this._paused = false;
      this._encoding = "utf8";
      this.writable = true;
    };
    util.inherits(ChunkStream, Stream);
    ChunkStream.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
      process.nextTick(
        function() {
          this._process();
          if (this._paused && this._reads && this._reads.length > 0) {
            this._paused = false;
            this.emit("drain");
          }
        }.bind(this)
      );
    };
    ChunkStream.prototype.write = function(data, encoding) {
      if (!this.writable) {
        this.emit("error", new Error("Stream not writable"));
        return false;
      }
      let dataBuffer;
      if (Buffer.isBuffer(data)) {
        dataBuffer = data;
      } else {
        dataBuffer = Buffer.from(data, encoding || this._encoding);
      }
      this._buffers.push(dataBuffer);
      this._buffered += dataBuffer.length;
      this._process();
      if (this._reads && this._reads.length === 0) {
        this._paused = true;
      }
      return this.writable && !this._paused;
    };
    ChunkStream.prototype.end = function(data, encoding) {
      if (data) {
        this.write(data, encoding);
      }
      this.writable = false;
      if (!this._buffers) {
        return;
      }
      if (this._buffers.length === 0) {
        this._end();
      } else {
        this._buffers.push(null);
        this._process();
      }
    };
    ChunkStream.prototype.destroySoon = ChunkStream.prototype.end;
    ChunkStream.prototype._end = function() {
      if (this._reads.length > 0) {
        this.emit("error", new Error("Unexpected end of input"));
      }
      this.destroy();
    };
    ChunkStream.prototype.destroy = function() {
      if (!this._buffers) {
        return;
      }
      this.writable = false;
      this._reads = null;
      this._buffers = null;
      this.emit("close");
    };
    ChunkStream.prototype._processReadAllowingLess = function(read) {
      this._reads.shift();
      let smallerBuf = this._buffers[0];
      if (smallerBuf.length > read.length) {
        this._buffered -= read.length;
        this._buffers[0] = smallerBuf.slice(read.length);
        read.func.call(this, smallerBuf.slice(0, read.length));
      } else {
        this._buffered -= smallerBuf.length;
        this._buffers.shift();
        read.func.call(this, smallerBuf);
      }
    };
    ChunkStream.prototype._processRead = function(read) {
      this._reads.shift();
      let pos = 0;
      let count = 0;
      let data = Buffer.alloc(read.length);
      while (pos < read.length) {
        let buf = this._buffers[count++];
        let len = Math.min(buf.length, read.length - pos);
        buf.copy(data, pos, 0, len);
        pos += len;
        if (len !== buf.length) {
          this._buffers[--count] = buf.slice(len);
        }
      }
      if (count > 0) {
        this._buffers.splice(0, count);
      }
      this._buffered -= read.length;
      read.func.call(this, data);
    };
    ChunkStream.prototype._process = function() {
      try {
        while (this._buffered > 0 && this._reads && this._reads.length > 0) {
          let read = this._reads[0];
          if (read.allowLess) {
            this._processReadAllowingLess(read);
          } else if (this._buffered >= read.length) {
            this._processRead(read);
          } else {
            break;
          }
        }
        if (this._buffers && !this.writable) {
          this._end();
        }
      } catch (ex) {
        this.emit("error", ex);
      }
    };
  }
});

// node_modules/pngjs/lib/interlace.js
var require_interlace = __commonJS({
  "node_modules/pngjs/lib/interlace.js"(exports2) {
    "use strict";
    var imagePasses = [
      {
        // pass 1 - 1px
        x: [0],
        y: [0]
      },
      {
        // pass 2 - 1px
        x: [4],
        y: [0]
      },
      {
        // pass 3 - 2px
        x: [0, 4],
        y: [4]
      },
      {
        // pass 4 - 4px
        x: [2, 6],
        y: [0, 4]
      },
      {
        // pass 5 - 8px
        x: [0, 2, 4, 6],
        y: [2, 6]
      },
      {
        // pass 6 - 16px
        x: [1, 3, 5, 7],
        y: [0, 2, 4, 6]
      },
      {
        // pass 7 - 32px
        x: [0, 1, 2, 3, 4, 5, 6, 7],
        y: [1, 3, 5, 7]
      }
    ];
    exports2.getImagePasses = function(width, height) {
      let images = [];
      let xLeftOver = width % 8;
      let yLeftOver = height % 8;
      let xRepeats = (width - xLeftOver) / 8;
      let yRepeats = (height - yLeftOver) / 8;
      for (let i = 0; i < imagePasses.length; i++) {
        let pass = imagePasses[i];
        let passWidth = xRepeats * pass.x.length;
        let passHeight = yRepeats * pass.y.length;
        for (let j = 0; j < pass.x.length; j++) {
          if (pass.x[j] < xLeftOver) {
            passWidth++;
          } else {
            break;
          }
        }
        for (let j = 0; j < pass.y.length; j++) {
          if (pass.y[j] < yLeftOver) {
            passHeight++;
          } else {
            break;
          }
        }
        if (passWidth > 0 && passHeight > 0) {
          images.push({ width: passWidth, height: passHeight, index: i });
        }
      }
      return images;
    };
    exports2.getInterlaceIterator = function(width) {
      return function(x, y, pass) {
        let outerXLeftOver = x % imagePasses[pass].x.length;
        let outerX = (x - outerXLeftOver) / imagePasses[pass].x.length * 8 + imagePasses[pass].x[outerXLeftOver];
        let outerYLeftOver = y % imagePasses[pass].y.length;
        let outerY = (y - outerYLeftOver) / imagePasses[pass].y.length * 8 + imagePasses[pass].y[outerYLeftOver];
        return outerX * 4 + outerY * width * 4;
      };
    };
  }
});

// node_modules/pngjs/lib/paeth-predictor.js
var require_paeth_predictor = __commonJS({
  "node_modules/pngjs/lib/paeth-predictor.js"(exports2, module2) {
    "use strict";
    module2.exports = function paethPredictor(left, above, upLeft) {
      let paeth = left + above - upLeft;
      let pLeft = Math.abs(paeth - left);
      let pAbove = Math.abs(paeth - above);
      let pUpLeft = Math.abs(paeth - upLeft);
      if (pLeft <= pAbove && pLeft <= pUpLeft) {
        return left;
      }
      if (pAbove <= pUpLeft) {
        return above;
      }
      return upLeft;
    };
  }
});

// node_modules/pngjs/lib/filter-parse.js
var require_filter_parse = __commonJS({
  "node_modules/pngjs/lib/filter-parse.js"(exports2, module2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var paethPredictor = require_paeth_predictor();
    function getByteWidth(width, bpp, depth) {
      let byteWidth = width * bpp;
      if (depth !== 8) {
        byteWidth = Math.ceil(byteWidth / (8 / depth));
      }
      return byteWidth;
    }
    var Filter = module2.exports = function(bitmapInfo, dependencies) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let interlace = bitmapInfo.interlace;
      let bpp = bitmapInfo.bpp;
      let depth = bitmapInfo.depth;
      this.read = dependencies.read;
      this.write = dependencies.write;
      this.complete = dependencies.complete;
      this._imageIndex = 0;
      this._images = [];
      if (interlace) {
        let passes = interlaceUtils.getImagePasses(width, height);
        for (let i = 0; i < passes.length; i++) {
          this._images.push({
            byteWidth: getByteWidth(passes[i].width, bpp, depth),
            height: passes[i].height,
            lineIndex: 0
          });
        }
      } else {
        this._images.push({
          byteWidth: getByteWidth(width, bpp, depth),
          height,
          lineIndex: 0
        });
      }
      if (depth === 8) {
        this._xComparison = bpp;
      } else if (depth === 16) {
        this._xComparison = bpp * 2;
      } else {
        this._xComparison = 1;
      }
    };
    Filter.prototype.start = function() {
      this.read(
        this._images[this._imageIndex].byteWidth + 1,
        this._reverseFilterLine.bind(this)
      );
    };
    Filter.prototype._unFilterType1 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f1Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        unfilteredLine[x] = rawByte + f1Left;
      }
    };
    Filter.prototype._unFilterType2 = function(rawData, unfilteredLine, byteWidth) {
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f2Up = lastLine ? lastLine[x] : 0;
        unfilteredLine[x] = rawByte + f2Up;
      }
    };
    Filter.prototype._unFilterType3 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f3Up = lastLine ? lastLine[x] : 0;
        let f3Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f3Add = Math.floor((f3Left + f3Up) / 2);
        unfilteredLine[x] = rawByte + f3Add;
      }
    };
    Filter.prototype._unFilterType4 = function(rawData, unfilteredLine, byteWidth) {
      let xComparison = this._xComparison;
      let xBiggerThan = xComparison - 1;
      let lastLine = this._lastLine;
      for (let x = 0; x < byteWidth; x++) {
        let rawByte = rawData[1 + x];
        let f4Up = lastLine ? lastLine[x] : 0;
        let f4Left = x > xBiggerThan ? unfilteredLine[x - xComparison] : 0;
        let f4UpLeft = x > xBiggerThan && lastLine ? lastLine[x - xComparison] : 0;
        let f4Add = paethPredictor(f4Left, f4Up, f4UpLeft);
        unfilteredLine[x] = rawByte + f4Add;
      }
    };
    Filter.prototype._reverseFilterLine = function(rawData) {
      let filter = rawData[0];
      let unfilteredLine;
      let currentImage = this._images[this._imageIndex];
      let byteWidth = currentImage.byteWidth;
      if (filter === 0) {
        unfilteredLine = rawData.slice(1, byteWidth + 1);
      } else {
        unfilteredLine = Buffer.alloc(byteWidth);
        switch (filter) {
          case 1:
            this._unFilterType1(rawData, unfilteredLine, byteWidth);
            break;
          case 2:
            this._unFilterType2(rawData, unfilteredLine, byteWidth);
            break;
          case 3:
            this._unFilterType3(rawData, unfilteredLine, byteWidth);
            break;
          case 4:
            this._unFilterType4(rawData, unfilteredLine, byteWidth);
            break;
          default:
            throw new Error("Unrecognised filter type - " + filter);
        }
      }
      this.write(unfilteredLine);
      currentImage.lineIndex++;
      if (currentImage.lineIndex >= currentImage.height) {
        this._lastLine = null;
        this._imageIndex++;
        currentImage = this._images[this._imageIndex];
      } else {
        this._lastLine = unfilteredLine;
      }
      if (currentImage) {
        this.read(currentImage.byteWidth + 1, this._reverseFilterLine.bind(this));
      } else {
        this._lastLine = null;
        this.complete();
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-async.js
var require_filter_parse_async = __commonJS({
  "node_modules/pngjs/lib/filter-parse-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var ChunkStream = require_chunkstream();
    var Filter = require_filter_parse();
    var FilterAsync = module2.exports = function(bitmapInfo) {
      ChunkStream.call(this);
      let buffers = [];
      let that = this;
      this._filter = new Filter(bitmapInfo, {
        read: this.read.bind(this),
        write: function(buffer) {
          buffers.push(buffer);
        },
        complete: function() {
          that.emit("complete", Buffer.concat(buffers));
        }
      });
      this._filter.start();
    };
    util.inherits(FilterAsync, ChunkStream);
  }
});

// node_modules/pngjs/lib/constants.js
var require_constants = __commonJS({
  "node_modules/pngjs/lib/constants.js"(exports2, module2) {
    "use strict";
    module2.exports = {
      PNG_SIGNATURE: [137, 80, 78, 71, 13, 10, 26, 10],
      TYPE_IHDR: 1229472850,
      TYPE_IEND: 1229278788,
      TYPE_IDAT: 1229209940,
      TYPE_PLTE: 1347179589,
      TYPE_tRNS: 1951551059,
      // eslint-disable-line camelcase
      TYPE_gAMA: 1732332865,
      // eslint-disable-line camelcase
      // color-type bits
      COLORTYPE_GRAYSCALE: 0,
      COLORTYPE_PALETTE: 1,
      COLORTYPE_COLOR: 2,
      COLORTYPE_ALPHA: 4,
      // e.g. grayscale and alpha
      // color-type combinations
      COLORTYPE_PALETTE_COLOR: 3,
      COLORTYPE_COLOR_ALPHA: 6,
      COLORTYPE_TO_BPP_MAP: {
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4
      },
      GAMMA_DIVISION: 1e5
    };
  }
});

// node_modules/pngjs/lib/crc.js
var require_crc = __commonJS({
  "node_modules/pngjs/lib/crc.js"(exports2, module2) {
    "use strict";
    var crcTable = [];
    (function() {
      for (let i = 0; i < 256; i++) {
        let currentCrc = i;
        for (let j = 0; j < 8; j++) {
          if (currentCrc & 1) {
            currentCrc = 3988292384 ^ currentCrc >>> 1;
          } else {
            currentCrc = currentCrc >>> 1;
          }
        }
        crcTable[i] = currentCrc;
      }
    })();
    var CrcCalculator = module2.exports = function() {
      this._crc = -1;
    };
    CrcCalculator.prototype.write = function(data) {
      for (let i = 0; i < data.length; i++) {
        this._crc = crcTable[(this._crc ^ data[i]) & 255] ^ this._crc >>> 8;
      }
      return true;
    };
    CrcCalculator.prototype.crc32 = function() {
      return this._crc ^ -1;
    };
    CrcCalculator.crc32 = function(buf) {
      let crc = -1;
      for (let i = 0; i < buf.length; i++) {
        crc = crcTable[(crc ^ buf[i]) & 255] ^ crc >>> 8;
      }
      return crc ^ -1;
    };
  }
});

// node_modules/pngjs/lib/parser.js
var require_parser = __commonJS({
  "node_modules/pngjs/lib/parser.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcCalculator = require_crc();
    var Parser = module2.exports = function(options, dependencies) {
      this._options = options;
      options.checkCRC = options.checkCRC !== false;
      this._hasIHDR = false;
      this._hasIEND = false;
      this._emittedHeadersFinished = false;
      this._palette = [];
      this._colorType = 0;
      this._chunks = {};
      this._chunks[constants.TYPE_IHDR] = this._handleIHDR.bind(this);
      this._chunks[constants.TYPE_IEND] = this._handleIEND.bind(this);
      this._chunks[constants.TYPE_IDAT] = this._handleIDAT.bind(this);
      this._chunks[constants.TYPE_PLTE] = this._handlePLTE.bind(this);
      this._chunks[constants.TYPE_tRNS] = this._handleTRNS.bind(this);
      this._chunks[constants.TYPE_gAMA] = this._handleGAMA.bind(this);
      this.read = dependencies.read;
      this.error = dependencies.error;
      this.metadata = dependencies.metadata;
      this.gamma = dependencies.gamma;
      this.transColor = dependencies.transColor;
      this.palette = dependencies.palette;
      this.parsed = dependencies.parsed;
      this.inflateData = dependencies.inflateData;
      this.finished = dependencies.finished;
      this.simpleTransparency = dependencies.simpleTransparency;
      this.headersFinished = dependencies.headersFinished || function() {
      };
    };
    Parser.prototype.start = function() {
      this.read(constants.PNG_SIGNATURE.length, this._parseSignature.bind(this));
    };
    Parser.prototype._parseSignature = function(data) {
      let signature = constants.PNG_SIGNATURE;
      for (let i = 0; i < signature.length; i++) {
        if (data[i] !== signature[i]) {
          this.error(new Error("Invalid file signature"));
          return;
        }
      }
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._parseChunkBegin = function(data) {
      let length = data.readUInt32BE(0);
      let type = data.readUInt32BE(4);
      let name = "";
      for (let i = 4; i < 8; i++) {
        name += String.fromCharCode(data[i]);
      }
      let ancillary = Boolean(data[4] & 32);
      if (!this._hasIHDR && type !== constants.TYPE_IHDR) {
        this.error(new Error("Expected IHDR on beggining"));
        return;
      }
      this._crc = new CrcCalculator();
      this._crc.write(Buffer.from(name));
      if (this._chunks[type]) {
        return this._chunks[type](length);
      }
      if (!ancillary) {
        this.error(new Error("Unsupported critical chunk type " + name));
        return;
      }
      this.read(length + 4, this._skipChunk.bind(this));
    };
    Parser.prototype._skipChunk = function() {
      this.read(8, this._parseChunkBegin.bind(this));
    };
    Parser.prototype._handleChunkEnd = function() {
      this.read(4, this._parseChunkEnd.bind(this));
    };
    Parser.prototype._parseChunkEnd = function(data) {
      let fileCrc = data.readInt32BE(0);
      let calcCrc = this._crc.crc32();
      if (this._options.checkCRC && calcCrc !== fileCrc) {
        this.error(new Error("Crc error - " + fileCrc + " - " + calcCrc));
        return;
      }
      if (!this._hasIEND) {
        this.read(8, this._parseChunkBegin.bind(this));
      }
    };
    Parser.prototype._handleIHDR = function(length) {
      this.read(length, this._parseIHDR.bind(this));
    };
    Parser.prototype._parseIHDR = function(data) {
      this._crc.write(data);
      let width = data.readUInt32BE(0);
      let height = data.readUInt32BE(4);
      let depth = data[8];
      let colorType = data[9];
      let compr = data[10];
      let filter = data[11];
      let interlace = data[12];
      if (depth !== 8 && depth !== 4 && depth !== 2 && depth !== 1 && depth !== 16) {
        this.error(new Error("Unsupported bit depth " + depth));
        return;
      }
      if (!(colorType in constants.COLORTYPE_TO_BPP_MAP)) {
        this.error(new Error("Unsupported color type"));
        return;
      }
      if (compr !== 0) {
        this.error(new Error("Unsupported compression method"));
        return;
      }
      if (filter !== 0) {
        this.error(new Error("Unsupported filter method"));
        return;
      }
      if (interlace !== 0 && interlace !== 1) {
        this.error(new Error("Unsupported interlace method"));
        return;
      }
      this._colorType = colorType;
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._colorType];
      this._hasIHDR = true;
      this.metadata({
        width,
        height,
        depth,
        interlace: Boolean(interlace),
        palette: Boolean(colorType & constants.COLORTYPE_PALETTE),
        color: Boolean(colorType & constants.COLORTYPE_COLOR),
        alpha: Boolean(colorType & constants.COLORTYPE_ALPHA),
        bpp,
        colorType
      });
      this._handleChunkEnd();
    };
    Parser.prototype._handlePLTE = function(length) {
      this.read(length, this._parsePLTE.bind(this));
    };
    Parser.prototype._parsePLTE = function(data) {
      this._crc.write(data);
      let entries = Math.floor(data.length / 3);
      for (let i = 0; i < entries; i++) {
        this._palette.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2], 255]);
      }
      this.palette(this._palette);
      this._handleChunkEnd();
    };
    Parser.prototype._handleTRNS = function(length) {
      this.simpleTransparency();
      this.read(length, this._parseTRNS.bind(this));
    };
    Parser.prototype._parseTRNS = function(data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR) {
        if (this._palette.length === 0) {
          this.error(new Error("Transparency chunk must be after palette"));
          return;
        }
        if (data.length > this._palette.length) {
          this.error(new Error("More transparent colors than palette size"));
          return;
        }
        for (let i = 0; i < data.length; i++) {
          this._palette[i][3] = data[i];
        }
        this.palette(this._palette);
      }
      if (this._colorType === constants.COLORTYPE_GRAYSCALE) {
        this.transColor([data.readUInt16BE(0)]);
      }
      if (this._colorType === constants.COLORTYPE_COLOR) {
        this.transColor([
          data.readUInt16BE(0),
          data.readUInt16BE(2),
          data.readUInt16BE(4)
        ]);
      }
      this._handleChunkEnd();
    };
    Parser.prototype._handleGAMA = function(length) {
      this.read(length, this._parseGAMA.bind(this));
    };
    Parser.prototype._parseGAMA = function(data) {
      this._crc.write(data);
      this.gamma(data.readUInt32BE(0) / constants.GAMMA_DIVISION);
      this._handleChunkEnd();
    };
    Parser.prototype._handleIDAT = function(length) {
      if (!this._emittedHeadersFinished) {
        this._emittedHeadersFinished = true;
        this.headersFinished();
      }
      this.read(-length, this._parseIDAT.bind(this, length));
    };
    Parser.prototype._parseIDAT = function(length, data) {
      this._crc.write(data);
      if (this._colorType === constants.COLORTYPE_PALETTE_COLOR && this._palette.length === 0) {
        throw new Error("Expected palette not found");
      }
      this.inflateData(data);
      let leftOverLength = length - data.length;
      if (leftOverLength > 0) {
        this._handleIDAT(leftOverLength);
      } else {
        this._handleChunkEnd();
      }
    };
    Parser.prototype._handleIEND = function(length) {
      this.read(length, this._parseIEND.bind(this));
    };
    Parser.prototype._parseIEND = function(data) {
      this._crc.write(data);
      this._hasIEND = true;
      this._handleChunkEnd();
      if (this.finished) {
        this.finished();
      }
    };
  }
});

// node_modules/pngjs/lib/bitmapper.js
var require_bitmapper = __commonJS({
  "node_modules/pngjs/lib/bitmapper.js"(exports2) {
    "use strict";
    var interlaceUtils = require_interlace();
    var pixelBppMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos === data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = 255;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 1 >= data.length) {
          throw new Error("Ran out of data");
        }
        let pixel = data[rawPos];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = data[rawPos + 1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 2 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = 255;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, data, pxPos, rawPos) {
        if (rawPos + 3 >= data.length) {
          throw new Error("Ran out of data");
        }
        pxData[pxPos] = data[rawPos];
        pxData[pxPos + 1] = data[rawPos + 1];
        pxData[pxPos + 2] = data[rawPos + 2];
        pxData[pxPos + 3] = data[rawPos + 3];
      }
    ];
    var pixelBppCustomMapper = [
      // 0 - dummy entry
      function() {
      },
      // 1 - L
      // 0: 0, 1: 0, 2: 0, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = maxBit;
      },
      // 2 - LA
      // 0: 0, 1: 0, 2: 0, 3: 1
      function(pxData, pixelData, pxPos) {
        let pixel = pixelData[0];
        pxData[pxPos] = pixel;
        pxData[pxPos + 1] = pixel;
        pxData[pxPos + 2] = pixel;
        pxData[pxPos + 3] = pixelData[1];
      },
      // 3 - RGB
      // 0: 0, 1: 1, 2: 2, 3: 0xff
      function(pxData, pixelData, pxPos, maxBit) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = maxBit;
      },
      // 4 - RGBA
      // 0: 0, 1: 1, 2: 2, 3: 3
      function(pxData, pixelData, pxPos) {
        pxData[pxPos] = pixelData[0];
        pxData[pxPos + 1] = pixelData[1];
        pxData[pxPos + 2] = pixelData[2];
        pxData[pxPos + 3] = pixelData[3];
      }
    ];
    function bitRetriever(data, depth) {
      let leftOver = [];
      let i = 0;
      function split() {
        if (i === data.length) {
          throw new Error("Ran out of data");
        }
        let byte = data[i];
        i++;
        let byte8, byte7, byte6, byte5, byte4, byte3, byte2, byte1;
        switch (depth) {
          default:
            throw new Error("unrecognised depth");
          case 16:
            byte2 = data[i];
            i++;
            leftOver.push((byte << 8) + byte2);
            break;
          case 4:
            byte2 = byte & 15;
            byte1 = byte >> 4;
            leftOver.push(byte1, byte2);
            break;
          case 2:
            byte4 = byte & 3;
            byte3 = byte >> 2 & 3;
            byte2 = byte >> 4 & 3;
            byte1 = byte >> 6 & 3;
            leftOver.push(byte1, byte2, byte3, byte4);
            break;
          case 1:
            byte8 = byte & 1;
            byte7 = byte >> 1 & 1;
            byte6 = byte >> 2 & 1;
            byte5 = byte >> 3 & 1;
            byte4 = byte >> 4 & 1;
            byte3 = byte >> 5 & 1;
            byte2 = byte >> 6 & 1;
            byte1 = byte >> 7 & 1;
            leftOver.push(byte1, byte2, byte3, byte4, byte5, byte6, byte7, byte8);
            break;
        }
      }
      return {
        get: function(count) {
          while (leftOver.length < count) {
            split();
          }
          let returner = leftOver.slice(0, count);
          leftOver = leftOver.slice(count);
          return returner;
        },
        resetAfterLine: function() {
          leftOver.length = 0;
        },
        end: function() {
          if (i !== data.length) {
            throw new Error("extra data found");
          }
        }
      };
    }
    function mapImage8Bit(image, pxData, getPxPos, bpp, data, rawPos) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppMapper[bpp](pxData, data, pxPos, rawPos);
          rawPos += bpp;
        }
      }
      return rawPos;
    }
    function mapImageCustomBit(image, pxData, getPxPos, bpp, bits, maxBit) {
      let imageWidth = image.width;
      let imageHeight = image.height;
      let imagePass = image.index;
      for (let y = 0; y < imageHeight; y++) {
        for (let x = 0; x < imageWidth; x++) {
          let pixelData = bits.get(bpp);
          let pxPos = getPxPos(x, y, imagePass);
          pixelBppCustomMapper[bpp](pxData, pixelData, pxPos, maxBit);
        }
        bits.resetAfterLine();
      }
    }
    exports2.dataToBitMap = function(data, bitmapInfo) {
      let width = bitmapInfo.width;
      let height = bitmapInfo.height;
      let depth = bitmapInfo.depth;
      let bpp = bitmapInfo.bpp;
      let interlace = bitmapInfo.interlace;
      let bits;
      if (depth !== 8) {
        bits = bitRetriever(data, depth);
      }
      let pxData;
      if (depth <= 8) {
        pxData = Buffer.alloc(width * height * 4);
      } else {
        pxData = new Uint16Array(width * height * 4);
      }
      let maxBit = Math.pow(2, depth) - 1;
      let rawPos = 0;
      let images;
      let getPxPos;
      if (interlace) {
        images = interlaceUtils.getImagePasses(width, height);
        getPxPos = interlaceUtils.getInterlaceIterator(width, height);
      } else {
        let nonInterlacedPxPos = 0;
        getPxPos = function() {
          let returner = nonInterlacedPxPos;
          nonInterlacedPxPos += 4;
          return returner;
        };
        images = [{ width, height }];
      }
      for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
        if (depth === 8) {
          rawPos = mapImage8Bit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            data,
            rawPos
          );
        } else {
          mapImageCustomBit(
            images[imageIndex],
            pxData,
            getPxPos,
            bpp,
            bits,
            maxBit
          );
        }
      }
      if (depth === 8) {
        if (rawPos !== data.length) {
          throw new Error("extra data found");
        }
      } else {
        bits.end();
      }
      return pxData;
    };
  }
});

// node_modules/pngjs/lib/format-normaliser.js
var require_format_normaliser = __commonJS({
  "node_modules/pngjs/lib/format-normaliser.js"(exports2, module2) {
    "use strict";
    function dePalette(indata, outdata, width, height, palette) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let color = palette[indata[pxPos]];
          if (!color) {
            throw new Error("index " + indata[pxPos] + " not in palette");
          }
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = color[i];
          }
          pxPos += 4;
        }
      }
    }
    function replaceTransparentColor(indata, outdata, width, height, transColor) {
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let makeTrans = false;
          if (transColor.length === 1) {
            if (transColor[0] === indata[pxPos]) {
              makeTrans = true;
            }
          } else if (transColor[0] === indata[pxPos] && transColor[1] === indata[pxPos + 1] && transColor[2] === indata[pxPos + 2]) {
            makeTrans = true;
          }
          if (makeTrans) {
            for (let i = 0; i < 4; i++) {
              outdata[pxPos + i] = 0;
            }
          }
          pxPos += 4;
        }
      }
    }
    function scaleDepth(indata, outdata, width, height, depth) {
      let maxOutSample = 255;
      let maxInSample = Math.pow(2, depth) - 1;
      let pxPos = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let i = 0; i < 4; i++) {
            outdata[pxPos + i] = Math.floor(
              indata[pxPos + i] * maxOutSample / maxInSample + 0.5
            );
          }
          pxPos += 4;
        }
      }
    }
    module2.exports = function(indata, imageData, skipRescale = false) {
      let depth = imageData.depth;
      let width = imageData.width;
      let height = imageData.height;
      let colorType = imageData.colorType;
      let transColor = imageData.transColor;
      let palette = imageData.palette;
      let outdata = indata;
      if (colorType === 3) {
        dePalette(indata, outdata, width, height, palette);
      } else {
        if (transColor) {
          replaceTransparentColor(indata, outdata, width, height, transColor);
        }
        if (depth !== 8 && !skipRescale) {
          if (depth === 16) {
            outdata = Buffer.alloc(width * height * 4);
          }
          scaleDepth(indata, outdata, width, height, depth);
        }
      }
      return outdata;
    };
  }
});

// node_modules/pngjs/lib/parser-async.js
var require_parser_async = __commonJS({
  "node_modules/pngjs/lib/parser-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var zlib = require("zlib");
    var ChunkStream = require_chunkstream();
    var FilterAsync = require_filter_parse_async();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    var ParserAsync = module2.exports = function(options) {
      ChunkStream.call(this);
      this._parser = new Parser(options, {
        read: this.read.bind(this),
        error: this._handleError.bind(this),
        metadata: this._handleMetaData.bind(this),
        gamma: this.emit.bind(this, "gamma"),
        palette: this._handlePalette.bind(this),
        transColor: this._handleTransColor.bind(this),
        finished: this._finished.bind(this),
        inflateData: this._inflateData.bind(this),
        simpleTransparency: this._simpleTransparency.bind(this),
        headersFinished: this._headersFinished.bind(this)
      });
      this._options = options;
      this.writable = true;
      this._parser.start();
    };
    util.inherits(ParserAsync, ChunkStream);
    ParserAsync.prototype._handleError = function(err) {
      this.emit("error", err);
      this.writable = false;
      this.destroy();
      if (this._inflate && this._inflate.destroy) {
        this._inflate.destroy();
      }
      if (this._filter) {
        this._filter.destroy();
        this._filter.on("error", function() {
        });
      }
      this.errord = true;
    };
    ParserAsync.prototype._inflateData = function(data) {
      if (!this._inflate) {
        if (this._bitmapInfo.interlace) {
          this._inflate = zlib.createInflate();
          this._inflate.on("error", this.emit.bind(this, "error"));
          this._filter.on("complete", this._complete.bind(this));
          this._inflate.pipe(this._filter);
        } else {
          let rowSize = (this._bitmapInfo.width * this._bitmapInfo.bpp * this._bitmapInfo.depth + 7 >> 3) + 1;
          let imageSize = rowSize * this._bitmapInfo.height;
          let chunkSize = Math.max(imageSize, zlib.Z_MIN_CHUNK);
          this._inflate = zlib.createInflate({ chunkSize });
          let leftToInflate = imageSize;
          let emitError = this.emit.bind(this, "error");
          this._inflate.on("error", function(err) {
            if (!leftToInflate) {
              return;
            }
            emitError(err);
          });
          this._filter.on("complete", this._complete.bind(this));
          let filterWrite = this._filter.write.bind(this._filter);
          this._inflate.on("data", function(chunk) {
            if (!leftToInflate) {
              return;
            }
            if (chunk.length > leftToInflate) {
              chunk = chunk.slice(0, leftToInflate);
            }
            leftToInflate -= chunk.length;
            filterWrite(chunk);
          });
          this._inflate.on("end", this._filter.end.bind(this._filter));
        }
      }
      this._inflate.write(data);
    };
    ParserAsync.prototype._handleMetaData = function(metaData) {
      this._metaData = metaData;
      this._bitmapInfo = Object.create(metaData);
      this._filter = new FilterAsync(this._bitmapInfo);
    };
    ParserAsync.prototype._handleTransColor = function(transColor) {
      this._bitmapInfo.transColor = transColor;
    };
    ParserAsync.prototype._handlePalette = function(palette) {
      this._bitmapInfo.palette = palette;
    };
    ParserAsync.prototype._simpleTransparency = function() {
      this._metaData.alpha = true;
    };
    ParserAsync.prototype._headersFinished = function() {
      this.emit("metadata", this._metaData);
    };
    ParserAsync.prototype._finished = function() {
      if (this.errord) {
        return;
      }
      if (!this._inflate) {
        this.emit("error", "No Inflate block");
      } else {
        this._inflate.end();
      }
    };
    ParserAsync.prototype._complete = function(filteredData) {
      if (this.errord) {
        return;
      }
      let normalisedBitmapData;
      try {
        let bitmapData = bitmapper.dataToBitMap(filteredData, this._bitmapInfo);
        normalisedBitmapData = formatNormaliser(
          bitmapData,
          this._bitmapInfo,
          this._options.skipRescale
        );
        bitmapData = null;
      } catch (ex) {
        this._handleError(ex);
        return;
      }
      this.emit("parsed", normalisedBitmapData);
    };
  }
});

// node_modules/pngjs/lib/bitpacker.js
var require_bitpacker = __commonJS({
  "node_modules/pngjs/lib/bitpacker.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    module2.exports = function(dataIn, width, height, options) {
      let outHasAlpha = [constants.COLORTYPE_COLOR_ALPHA, constants.COLORTYPE_ALPHA].indexOf(
        options.colorType
      ) !== -1;
      if (options.colorType === options.inputColorType) {
        let bigEndian = (function() {
          let buffer = new ArrayBuffer(2);
          new DataView(buffer).setInt16(
            0,
            256,
            true
            /* littleEndian */
          );
          return new Int16Array(buffer)[0] !== 256;
        })();
        if (options.bitDepth === 8 || options.bitDepth === 16 && bigEndian) {
          return dataIn;
        }
      }
      let data = options.bitDepth !== 16 ? dataIn : new Uint16Array(dataIn.buffer);
      let maxValue = 255;
      let inBpp = constants.COLORTYPE_TO_BPP_MAP[options.inputColorType];
      if (inBpp === 4 && !options.inputHasAlpha) {
        inBpp = 3;
      }
      let outBpp = constants.COLORTYPE_TO_BPP_MAP[options.colorType];
      if (options.bitDepth === 16) {
        maxValue = 65535;
        outBpp *= 2;
      }
      let outData = Buffer.alloc(width * height * outBpp);
      let inIndex = 0;
      let outIndex = 0;
      let bgColor = options.bgColor || {};
      if (bgColor.red === void 0) {
        bgColor.red = maxValue;
      }
      if (bgColor.green === void 0) {
        bgColor.green = maxValue;
      }
      if (bgColor.blue === void 0) {
        bgColor.blue = maxValue;
      }
      function getRGBA() {
        let red;
        let green;
        let blue;
        let alpha = maxValue;
        switch (options.inputColorType) {
          case constants.COLORTYPE_COLOR_ALPHA:
            alpha = data[inIndex + 3];
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_COLOR:
            red = data[inIndex];
            green = data[inIndex + 1];
            blue = data[inIndex + 2];
            break;
          case constants.COLORTYPE_ALPHA:
            alpha = data[inIndex + 1];
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          case constants.COLORTYPE_GRAYSCALE:
            red = data[inIndex];
            green = red;
            blue = red;
            break;
          default:
            throw new Error(
              "input color type:" + options.inputColorType + " is not supported at present"
            );
        }
        if (options.inputHasAlpha) {
          if (!outHasAlpha) {
            alpha /= maxValue;
            red = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.red + alpha * red), 0),
              maxValue
            );
            green = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.green + alpha * green), 0),
              maxValue
            );
            blue = Math.min(
              Math.max(Math.round((1 - alpha) * bgColor.blue + alpha * blue), 0),
              maxValue
            );
          }
        }
        return { red, green, blue, alpha };
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let rgba = getRGBA(data, inIndex);
          switch (options.colorType) {
            case constants.COLORTYPE_COLOR_ALPHA:
            case constants.COLORTYPE_COLOR:
              if (options.bitDepth === 8) {
                outData[outIndex] = rgba.red;
                outData[outIndex + 1] = rgba.green;
                outData[outIndex + 2] = rgba.blue;
                if (outHasAlpha) {
                  outData[outIndex + 3] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(rgba.red, outIndex);
                outData.writeUInt16BE(rgba.green, outIndex + 2);
                outData.writeUInt16BE(rgba.blue, outIndex + 4);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 6);
                }
              }
              break;
            case constants.COLORTYPE_ALPHA:
            case constants.COLORTYPE_GRAYSCALE: {
              let grayscale = (rgba.red + rgba.green + rgba.blue) / 3;
              if (options.bitDepth === 8) {
                outData[outIndex] = grayscale;
                if (outHasAlpha) {
                  outData[outIndex + 1] = rgba.alpha;
                }
              } else {
                outData.writeUInt16BE(grayscale, outIndex);
                if (outHasAlpha) {
                  outData.writeUInt16BE(rgba.alpha, outIndex + 2);
                }
              }
              break;
            }
            default:
              throw new Error("unrecognised color Type " + options.colorType);
          }
          inIndex += inBpp;
          outIndex += outBpp;
        }
      }
      return outData;
    };
  }
});

// node_modules/pngjs/lib/filter-pack.js
var require_filter_pack = __commonJS({
  "node_modules/pngjs/lib/filter-pack.js"(exports2, module2) {
    "use strict";
    var paethPredictor = require_paeth_predictor();
    function filterNone(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        rawData[rawPos + x] = pxData[pxPos + x];
      }
    }
    function filterSumNone(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let i = pxPos; i < length; i++) {
        sum += Math.abs(pxData[i]);
      }
      return sum;
    }
    function filterSub(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumSub(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let val = pxData[pxPos + x] - left;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterUp(pxData, pxPos, byteWidth, rawData, rawPos) {
      for (let x = 0; x < byteWidth; x++) {
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - up;
        rawData[rawPos + x] = val;
      }
    }
    function filterSumUp(pxData, pxPos, byteWidth) {
      let sum = 0;
      let length = pxPos + byteWidth;
      for (let x = pxPos; x < length; x++) {
        let up = pxPos > 0 ? pxData[x - byteWidth] : 0;
        let val = pxData[x] - up;
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterAvg(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumAvg(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let val = pxData[pxPos + x] - (left + up >> 1);
        sum += Math.abs(val);
      }
      return sum;
    }
    function filterPaeth(pxData, pxPos, byteWidth, rawData, rawPos, bpp) {
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        rawData[rawPos + x] = val;
      }
    }
    function filterSumPaeth(pxData, pxPos, byteWidth, bpp) {
      let sum = 0;
      for (let x = 0; x < byteWidth; x++) {
        let left = x >= bpp ? pxData[pxPos + x - bpp] : 0;
        let up = pxPos > 0 ? pxData[pxPos + x - byteWidth] : 0;
        let upleft = pxPos > 0 && x >= bpp ? pxData[pxPos + x - (byteWidth + bpp)] : 0;
        let val = pxData[pxPos + x] - paethPredictor(left, up, upleft);
        sum += Math.abs(val);
      }
      return sum;
    }
    var filters = {
      0: filterNone,
      1: filterSub,
      2: filterUp,
      3: filterAvg,
      4: filterPaeth
    };
    var filterSums = {
      0: filterSumNone,
      1: filterSumSub,
      2: filterSumUp,
      3: filterSumAvg,
      4: filterSumPaeth
    };
    module2.exports = function(pxData, width, height, options, bpp) {
      let filterTypes;
      if (!("filterType" in options) || options.filterType === -1) {
        filterTypes = [0, 1, 2, 3, 4];
      } else if (typeof options.filterType === "number") {
        filterTypes = [options.filterType];
      } else {
        throw new Error("unrecognised filter types");
      }
      if (options.bitDepth === 16) {
        bpp *= 2;
      }
      let byteWidth = width * bpp;
      let rawPos = 0;
      let pxPos = 0;
      let rawData = Buffer.alloc((byteWidth + 1) * height);
      let sel = filterTypes[0];
      for (let y = 0; y < height; y++) {
        if (filterTypes.length > 1) {
          let min = Infinity;
          for (let i = 0; i < filterTypes.length; i++) {
            let sum = filterSums[filterTypes[i]](pxData, pxPos, byteWidth, bpp);
            if (sum < min) {
              sel = filterTypes[i];
              min = sum;
            }
          }
        }
        rawData[rawPos] = sel;
        rawPos++;
        filters[sel](pxData, pxPos, byteWidth, rawData, rawPos, bpp);
        rawPos += byteWidth;
        pxPos += byteWidth;
      }
      return rawData;
    };
  }
});

// node_modules/pngjs/lib/packer.js
var require_packer = __commonJS({
  "node_modules/pngjs/lib/packer.js"(exports2, module2) {
    "use strict";
    var constants = require_constants();
    var CrcStream = require_crc();
    var bitPacker = require_bitpacker();
    var filter = require_filter_pack();
    var zlib = require("zlib");
    var Packer = module2.exports = function(options) {
      this._options = options;
      options.deflateChunkSize = options.deflateChunkSize || 32 * 1024;
      options.deflateLevel = options.deflateLevel != null ? options.deflateLevel : 9;
      options.deflateStrategy = options.deflateStrategy != null ? options.deflateStrategy : 3;
      options.inputHasAlpha = options.inputHasAlpha != null ? options.inputHasAlpha : true;
      options.deflateFactory = options.deflateFactory || zlib.createDeflate;
      options.bitDepth = options.bitDepth || 8;
      options.colorType = typeof options.colorType === "number" ? options.colorType : constants.COLORTYPE_COLOR_ALPHA;
      options.inputColorType = typeof options.inputColorType === "number" ? options.inputColorType : constants.COLORTYPE_COLOR_ALPHA;
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.colorType) === -1) {
        throw new Error(
          "option color type:" + options.colorType + " is not supported at present"
        );
      }
      if ([
        constants.COLORTYPE_GRAYSCALE,
        constants.COLORTYPE_COLOR,
        constants.COLORTYPE_COLOR_ALPHA,
        constants.COLORTYPE_ALPHA
      ].indexOf(options.inputColorType) === -1) {
        throw new Error(
          "option input color type:" + options.inputColorType + " is not supported at present"
        );
      }
      if (options.bitDepth !== 8 && options.bitDepth !== 16) {
        throw new Error(
          "option bit depth:" + options.bitDepth + " is not supported at present"
        );
      }
    };
    Packer.prototype.getDeflateOptions = function() {
      return {
        chunkSize: this._options.deflateChunkSize,
        level: this._options.deflateLevel,
        strategy: this._options.deflateStrategy
      };
    };
    Packer.prototype.createDeflate = function() {
      return this._options.deflateFactory(this.getDeflateOptions());
    };
    Packer.prototype.filterData = function(data, width, height) {
      let packedData = bitPacker(data, width, height, this._options);
      let bpp = constants.COLORTYPE_TO_BPP_MAP[this._options.colorType];
      let filteredData = filter(packedData, width, height, this._options, bpp);
      return filteredData;
    };
    Packer.prototype._packChunk = function(type, data) {
      let len = data ? data.length : 0;
      let buf = Buffer.alloc(len + 12);
      buf.writeUInt32BE(len, 0);
      buf.writeUInt32BE(type, 4);
      if (data) {
        data.copy(buf, 8);
      }
      buf.writeInt32BE(
        CrcStream.crc32(buf.slice(4, buf.length - 4)),
        buf.length - 4
      );
      return buf;
    };
    Packer.prototype.packGAMA = function(gamma) {
      let buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.floor(gamma * constants.GAMMA_DIVISION), 0);
      return this._packChunk(constants.TYPE_gAMA, buf);
    };
    Packer.prototype.packIHDR = function(width, height) {
      let buf = Buffer.alloc(13);
      buf.writeUInt32BE(width, 0);
      buf.writeUInt32BE(height, 4);
      buf[8] = this._options.bitDepth;
      buf[9] = this._options.colorType;
      buf[10] = 0;
      buf[11] = 0;
      buf[12] = 0;
      return this._packChunk(constants.TYPE_IHDR, buf);
    };
    Packer.prototype.packIDAT = function(data) {
      return this._packChunk(constants.TYPE_IDAT, data);
    };
    Packer.prototype.packIEND = function() {
      return this._packChunk(constants.TYPE_IEND, null);
    };
  }
});

// node_modules/pngjs/lib/packer-async.js
var require_packer_async = __commonJS({
  "node_modules/pngjs/lib/packer-async.js"(exports2, module2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var constants = require_constants();
    var Packer = require_packer();
    var PackerAsync = module2.exports = function(opt) {
      Stream.call(this);
      let options = opt || {};
      this._packer = new Packer(options);
      this._deflate = this._packer.createDeflate();
      this.readable = true;
    };
    util.inherits(PackerAsync, Stream);
    PackerAsync.prototype.pack = function(data, width, height, gamma) {
      this.emit("data", Buffer.from(constants.PNG_SIGNATURE));
      this.emit("data", this._packer.packIHDR(width, height));
      if (gamma) {
        this.emit("data", this._packer.packGAMA(gamma));
      }
      let filteredData = this._packer.filterData(data, width, height);
      this._deflate.on("error", this.emit.bind(this, "error"));
      this._deflate.on(
        "data",
        function(compressedData) {
          this.emit("data", this._packer.packIDAT(compressedData));
        }.bind(this)
      );
      this._deflate.on(
        "end",
        function() {
          this.emit("data", this._packer.packIEND());
          this.emit("end");
        }.bind(this)
      );
      this._deflate.end(filteredData);
    };
  }
});

// node_modules/pngjs/lib/sync-inflate.js
var require_sync_inflate = __commonJS({
  "node_modules/pngjs/lib/sync-inflate.js"(exports2, module2) {
    "use strict";
    var assert = require("assert").ok;
    var zlib = require("zlib");
    var util = require("util");
    var kMaxLength = require("buffer").kMaxLength;
    function Inflate(opts) {
      if (!(this instanceof Inflate)) {
        return new Inflate(opts);
      }
      if (opts && opts.chunkSize < zlib.Z_MIN_CHUNK) {
        opts.chunkSize = zlib.Z_MIN_CHUNK;
      }
      zlib.Inflate.call(this, opts);
      this._offset = this._offset === void 0 ? this._outOffset : this._offset;
      this._buffer = this._buffer || this._outBuffer;
      if (opts && opts.maxLength != null) {
        this._maxLength = opts.maxLength;
      }
    }
    function createInflate(opts) {
      return new Inflate(opts);
    }
    function _close(engine, callback) {
      if (callback) {
        process.nextTick(callback);
      }
      if (!engine._handle) {
        return;
      }
      engine._handle.close();
      engine._handle = null;
    }
    Inflate.prototype._processChunk = function(chunk, flushFlag, asyncCb) {
      if (typeof asyncCb === "function") {
        return zlib.Inflate._processChunk.call(this, chunk, flushFlag, asyncCb);
      }
      let self = this;
      let availInBefore = chunk && chunk.length;
      let availOutBefore = this._chunkSize - this._offset;
      let leftToInflate = this._maxLength;
      let inOff = 0;
      let buffers = [];
      let nread = 0;
      let error;
      this.on("error", function(err) {
        error = err;
      });
      function handleChunk(availInAfter, availOutAfter) {
        if (self._hadError) {
          return;
        }
        let have = availOutBefore - availOutAfter;
        assert(have >= 0, "have should not go down");
        if (have > 0) {
          let out = self._buffer.slice(self._offset, self._offset + have);
          self._offset += have;
          if (out.length > leftToInflate) {
            out = out.slice(0, leftToInflate);
          }
          buffers.push(out);
          nread += out.length;
          leftToInflate -= out.length;
          if (leftToInflate === 0) {
            return false;
          }
        }
        if (availOutAfter === 0 || self._offset >= self._chunkSize) {
          availOutBefore = self._chunkSize;
          self._offset = 0;
          self._buffer = Buffer.allocUnsafe(self._chunkSize);
        }
        if (availOutAfter === 0) {
          inOff += availInBefore - availInAfter;
          availInBefore = availInAfter;
          return true;
        }
        return false;
      }
      assert(this._handle, "zlib binding closed");
      let res;
      do {
        res = this._handle.writeSync(
          flushFlag,
          chunk,
          // in
          inOff,
          // in_off
          availInBefore,
          // in_len
          this._buffer,
          // out
          this._offset,
          //out_off
          availOutBefore
        );
        res = res || this._writeState;
      } while (!this._hadError && handleChunk(res[0], res[1]));
      if (this._hadError) {
        throw error;
      }
      if (nread >= kMaxLength) {
        _close(this);
        throw new RangeError(
          "Cannot create final Buffer. It would be larger than 0x" + kMaxLength.toString(16) + " bytes"
        );
      }
      let buf = Buffer.concat(buffers, nread);
      _close(this);
      return buf;
    };
    util.inherits(Inflate, zlib.Inflate);
    function zlibBufferSync(engine, buffer) {
      if (typeof buffer === "string") {
        buffer = Buffer.from(buffer);
      }
      if (!(buffer instanceof Buffer)) {
        throw new TypeError("Not a string or buffer");
      }
      let flushFlag = engine._finishFlushFlag;
      if (flushFlag == null) {
        flushFlag = zlib.Z_FINISH;
      }
      return engine._processChunk(buffer, flushFlag);
    }
    function inflateSync(buffer, opts) {
      return zlibBufferSync(new Inflate(opts), buffer);
    }
    module2.exports = exports2 = inflateSync;
    exports2.Inflate = Inflate;
    exports2.createInflate = createInflate;
    exports2.inflateSync = inflateSync;
  }
});

// node_modules/pngjs/lib/sync-reader.js
var require_sync_reader = __commonJS({
  "node_modules/pngjs/lib/sync-reader.js"(exports2, module2) {
    "use strict";
    var SyncReader = module2.exports = function(buffer) {
      this._buffer = buffer;
      this._reads = [];
    };
    SyncReader.prototype.read = function(length, callback) {
      this._reads.push({
        length: Math.abs(length),
        // if length < 0 then at most this length
        allowLess: length < 0,
        func: callback
      });
    };
    SyncReader.prototype.process = function() {
      while (this._reads.length > 0 && this._buffer.length) {
        let read = this._reads[0];
        if (this._buffer.length && (this._buffer.length >= read.length || read.allowLess)) {
          this._reads.shift();
          let buf = this._buffer;
          this._buffer = buf.slice(read.length);
          read.func.call(this, buf.slice(0, read.length));
        } else {
          break;
        }
      }
      if (this._reads.length > 0) {
        throw new Error("There are some read requests waitng on finished stream");
      }
      if (this._buffer.length > 0) {
        throw new Error("unrecognised content at end of stream");
      }
    };
  }
});

// node_modules/pngjs/lib/filter-parse-sync.js
var require_filter_parse_sync = __commonJS({
  "node_modules/pngjs/lib/filter-parse-sync.js"(exports2) {
    "use strict";
    var SyncReader = require_sync_reader();
    var Filter = require_filter_parse();
    exports2.process = function(inBuffer, bitmapInfo) {
      let outBuffers = [];
      let reader = new SyncReader(inBuffer);
      let filter = new Filter(bitmapInfo, {
        read: reader.read.bind(reader),
        write: function(bufferPart) {
          outBuffers.push(bufferPart);
        },
        complete: function() {
        }
      });
      filter.start();
      reader.process();
      return Buffer.concat(outBuffers);
    };
  }
});

// node_modules/pngjs/lib/parser-sync.js
var require_parser_sync = __commonJS({
  "node_modules/pngjs/lib/parser-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    var inflateSync = require_sync_inflate();
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var SyncReader = require_sync_reader();
    var FilterSync = require_filter_parse_sync();
    var Parser = require_parser();
    var bitmapper = require_bitmapper();
    var formatNormaliser = require_format_normaliser();
    module2.exports = function(buffer, options) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let err;
      function handleError(_err_) {
        err = _err_;
      }
      let metaData;
      function handleMetaData(_metaData_) {
        metaData = _metaData_;
      }
      function handleTransColor(transColor) {
        metaData.transColor = transColor;
      }
      function handlePalette(palette) {
        metaData.palette = palette;
      }
      function handleSimpleTransparency() {
        metaData.alpha = true;
      }
      let gamma;
      function handleGamma(_gamma_) {
        gamma = _gamma_;
      }
      let inflateDataList = [];
      function handleInflateData(inflatedData2) {
        inflateDataList.push(inflatedData2);
      }
      let reader = new SyncReader(buffer);
      let parser = new Parser(options, {
        read: reader.read.bind(reader),
        error: handleError,
        metadata: handleMetaData,
        gamma: handleGamma,
        palette: handlePalette,
        transColor: handleTransColor,
        inflateData: handleInflateData,
        simpleTransparency: handleSimpleTransparency
      });
      parser.start();
      reader.process();
      if (err) {
        throw err;
      }
      let inflateData = Buffer.concat(inflateDataList);
      inflateDataList.length = 0;
      let inflatedData;
      if (metaData.interlace) {
        inflatedData = zlib.inflateSync(inflateData);
      } else {
        let rowSize = (metaData.width * metaData.bpp * metaData.depth + 7 >> 3) + 1;
        let imageSize = rowSize * metaData.height;
        inflatedData = inflateSync(inflateData, {
          chunkSize: imageSize,
          maxLength: imageSize
        });
      }
      inflateData = null;
      if (!inflatedData || !inflatedData.length) {
        throw new Error("bad png - invalid inflate data response");
      }
      let unfilteredData = FilterSync.process(inflatedData, metaData);
      inflateData = null;
      let bitmapData = bitmapper.dataToBitMap(unfilteredData, metaData);
      unfilteredData = null;
      let normalisedBitmapData = formatNormaliser(
        bitmapData,
        metaData,
        options.skipRescale
      );
      metaData.data = normalisedBitmapData;
      metaData.gamma = gamma || 0;
      return metaData;
    };
  }
});

// node_modules/pngjs/lib/packer-sync.js
var require_packer_sync = __commonJS({
  "node_modules/pngjs/lib/packer-sync.js"(exports2, module2) {
    "use strict";
    var hasSyncZlib = true;
    var zlib = require("zlib");
    if (!zlib.deflateSync) {
      hasSyncZlib = false;
    }
    var constants = require_constants();
    var Packer = require_packer();
    module2.exports = function(metaData, opt) {
      if (!hasSyncZlib) {
        throw new Error(
          "To use the sync capability of this library in old node versions, please pin pngjs to v2.3.0"
        );
      }
      let options = opt || {};
      let packer = new Packer(options);
      let chunks = [];
      chunks.push(Buffer.from(constants.PNG_SIGNATURE));
      chunks.push(packer.packIHDR(metaData.width, metaData.height));
      if (metaData.gamma) {
        chunks.push(packer.packGAMA(metaData.gamma));
      }
      let filteredData = packer.filterData(
        metaData.data,
        metaData.width,
        metaData.height
      );
      let compressedData = zlib.deflateSync(
        filteredData,
        packer.getDeflateOptions()
      );
      filteredData = null;
      if (!compressedData || !compressedData.length) {
        throw new Error("bad png - invalid compressed data response");
      }
      chunks.push(packer.packIDAT(compressedData));
      chunks.push(packer.packIEND());
      return Buffer.concat(chunks);
    };
  }
});

// node_modules/pngjs/lib/png-sync.js
var require_png_sync = __commonJS({
  "node_modules/pngjs/lib/png-sync.js"(exports2) {
    "use strict";
    var parse = require_parser_sync();
    var pack = require_packer_sync();
    exports2.read = function(buffer, options) {
      return parse(buffer, options || {});
    };
    exports2.write = function(png, options) {
      return pack(png, options);
    };
  }
});

// node_modules/pngjs/lib/png.js
var require_png = __commonJS({
  "node_modules/pngjs/lib/png.js"(exports2) {
    "use strict";
    var util = require("util");
    var Stream = require("stream");
    var Parser = require_parser_async();
    var Packer = require_packer_async();
    var PNGSync = require_png_sync();
    var PNG2 = exports2.PNG = function(options) {
      Stream.call(this);
      options = options || {};
      this.width = options.width | 0;
      this.height = options.height | 0;
      this.data = this.width > 0 && this.height > 0 ? Buffer.alloc(4 * this.width * this.height) : null;
      if (options.fill && this.data) {
        this.data.fill(0);
      }
      this.gamma = 0;
      this.readable = this.writable = true;
      this._parser = new Parser(options);
      this._parser.on("error", this.emit.bind(this, "error"));
      this._parser.on("close", this._handleClose.bind(this));
      this._parser.on("metadata", this._metadata.bind(this));
      this._parser.on("gamma", this._gamma.bind(this));
      this._parser.on(
        "parsed",
        function(data) {
          this.data = data;
          this.emit("parsed", data);
        }.bind(this)
      );
      this._packer = new Packer(options);
      this._packer.on("data", this.emit.bind(this, "data"));
      this._packer.on("end", this.emit.bind(this, "end"));
      this._parser.on("close", this._handleClose.bind(this));
      this._packer.on("error", this.emit.bind(this, "error"));
    };
    util.inherits(PNG2, Stream);
    PNG2.sync = PNGSync;
    PNG2.prototype.pack = function() {
      if (!this.data || !this.data.length) {
        this.emit("error", "No data provided");
        return this;
      }
      process.nextTick(
        function() {
          this._packer.pack(this.data, this.width, this.height, this.gamma);
        }.bind(this)
      );
      return this;
    };
    PNG2.prototype.parse = function(data, callback) {
      if (callback) {
        let onParsed, onError;
        onParsed = function(parsedData) {
          this.removeListener("error", onError);
          this.data = parsedData;
          callback(null, this);
        }.bind(this);
        onError = function(err) {
          this.removeListener("parsed", onParsed);
          callback(err, null);
        }.bind(this);
        this.once("parsed", onParsed);
        this.once("error", onError);
      }
      this.end(data);
      return this;
    };
    PNG2.prototype.write = function(data) {
      this._parser.write(data);
      return true;
    };
    PNG2.prototype.end = function(data) {
      this._parser.end(data);
    };
    PNG2.prototype._metadata = function(metadata) {
      this.width = metadata.width;
      this.height = metadata.height;
      this.emit("metadata", metadata);
    };
    PNG2.prototype._gamma = function(gamma) {
      this.gamma = gamma;
    };
    PNG2.prototype._handleClose = function() {
      if (!this._parser.writable && !this._packer.readable) {
        this.emit("close");
      }
    };
    PNG2.bitblt = function(src, dst, srcX, srcY, width, height, deltaX, deltaY) {
      srcX |= 0;
      srcY |= 0;
      width |= 0;
      height |= 0;
      deltaX |= 0;
      deltaY |= 0;
      if (srcX > src.width || srcY > src.height || srcX + width > src.width || srcY + height > src.height) {
        throw new Error("bitblt reading outside image");
      }
      if (deltaX > dst.width || deltaY > dst.height || deltaX + width > dst.width || deltaY + height > dst.height) {
        throw new Error("bitblt writing outside image");
      }
      for (let y = 0; y < height; y++) {
        src.data.copy(
          dst.data,
          (deltaY + y) * dst.width + deltaX << 2,
          (srcY + y) * src.width + srcX << 2,
          (srcY + y) * src.width + srcX + width << 2
        );
      }
    };
    PNG2.prototype.bitblt = function(dst, srcX, srcY, width, height, deltaX, deltaY) {
      PNG2.bitblt(this, dst, srcX, srcY, width, height, deltaX, deltaY);
      return this;
    };
    PNG2.adjustGamma = function(src) {
      if (src.gamma) {
        for (let y = 0; y < src.height; y++) {
          for (let x = 0; x < src.width; x++) {
            let idx = src.width * y + x << 2;
            for (let i = 0; i < 3; i++) {
              let sample = src.data[idx + i] / 255;
              sample = Math.pow(sample, 1 / 2.2 / src.gamma);
              src.data[idx + i] = Math.round(sample * 255);
            }
          }
        }
        src.gamma = 0;
      }
    };
    PNG2.prototype.adjustGamma = function() {
      PNG2.adjustGamma(this);
    };
  }
});

// source/figma/mask-tint.ts
var mask_tint_exports = {};
__export(mask_tint_exports, {
  analyzeMaskTint: () => analyzeMaskTint,
  verifyWhiteAlphaPng: () => verifyWhiteAlphaPng
});
module.exports = __toCommonJS(mask_tint_exports);
var import_pngjs = __toESM(require_png());
var EPSILON = 1e-4;
var normalBlend = (node) => !node.blendMode || ["NORMAL", "PASS_THROUGH"].includes(node.blendMode);
var noEffects = (node) => !node.effects.some((effect) => effect.visible !== false) && !(node.strokeWeight > 0 && node.strokes.some((paint) => paint.visible !== false));
var paints = (node) => node.fills.filter((paint) => paint.visible !== false && (paint.opacity ?? 1) > 0);
var neutralTransform = (node) => {
  var _a, _b, _c, _d;
  return Math.abs(node.rotation) <= EPSILON && (!node.relativeTransform || node.relativeTransform.length === 2 && Math.abs(((_a = node.relativeTransform[0]) == null ? void 0 : _a[0]) - 1) <= EPSILON && Math.abs((_b = node.relativeTransform[0]) == null ? void 0 : _b[1]) <= EPSILON && Math.abs((_c = node.relativeTransform[1]) == null ? void 0 : _c[0]) <= EPSILON && Math.abs(((_d = node.relativeTransform[1]) == null ? void 0 : _d[1]) - 1) <= EPSILON);
};
var sameFrame = (a, b) => Boolean(a && b && ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= EPSILON));
function analyzeMaskTint(node) {
  if (!node.children.some((child) => child.isMask)) return void 0;
  const fail = (reason) => ({ reason });
  if (!normalBlend(node) || !noEffects(node) || paints(node).length || !neutralTransform(node) || node.layoutMode && node.layoutMode !== "NONE" || node.overflowDirection || node.clipsContent) return fail("\u8499\u7248\u5BB9\u5668\u5E26\u6709\u989D\u5916\u7ED8\u5236\u3001\u53D8\u6362\u3001\u88C1\u5207\u6216\u8FD0\u884C\u65F6\u5E03\u5C40");
  if (node.children.length !== 2) return fail("\u4EC5\u652F\u6301\u4E00\u4E2A\u771F\u5B9E Alpha \u8499\u7248\u4E0E\u4E00\u4E2A\u7EAF\u8272\u8986\u76D6\u5C42");
  const [mask, cover] = node.children;
  if (!mask.isMask || mask.maskType !== "ALPHA" || cover.isMask) return fail("\u8499\u7248\u7C7B\u578B\u672A\u660E\u786E\u4E3A ALPHA\uFF0C\u6216\u8499\u7248\u987A\u5E8F/\u6570\u91CF\u4E0D\u53D7\u652F\u6301");
  if (!mask.visible || !cover.visible || mask.opacity !== 1) return fail("\u8499\u7248/\u8986\u76D6\u5C42\u9690\u85CF\u6216\u8499\u7248\u900F\u660E\u5EA6\u4E0D\u4E3A 100%");
  if (!normalBlend(mask) || !normalBlend(cover) || !noEffects(mask) || !noEffects(cover) || !neutralTransform(mask) || !neutralTransform(cover) || !sameFrame(node.absoluteBoundingBox, mask.absoluteBoundingBox) || !sameFrame(node.absoluteBoundingBox, cover.absoluteBoundingBox)) return fail("\u8499\u7248\u4E0E\u8986\u76D6\u5C42\u7684\u51E0\u4F55\u3001\u6DF7\u5408\u6216\u6548\u679C\u4E0D\u80FD\u7B49\u4EF7\u6620\u5C04");
  if (cover.type !== "RECTANGLE" || cover.children.length || [cover.cornerRadius ?? 0, ...cover.rectangleCornerRadii ?? []].some((radius) => radius > 0)) {
    return fail("\u7EAF\u8272\u8986\u76D6\u5C42\u4E0D\u662F\u5B8C\u6574\u65E0\u5706\u89D2\u77E9\u5F62");
  }
  const fills = paints(cover);
  const fill = fills[0];
  if (fills.length !== 1 || fill.type !== "SOLID" || !fill.color || fill.blendMode && fill.blendMode !== "NORMAL") return fail("\u8986\u76D6\u5C42\u4E0D\u662F\u5355\u4E00\u666E\u901A\u6DF7\u5408\u7684\u7EAF\u8272\u586B\u5145");
  const safeMask = (part, root = false) => normalBlend(part) && noEffects(part) && neutralTransform(part) && part.visible && part.opacity === 1 && (root || !part.isMask) && !part.clipsContent && paints(part).every((paint) => {
    var _a;
    return (!paint.blendMode || paint.blendMode === "NORMAL") && (paint.opacity ?? 1) === 1 && (paint.type === "IMAGE" && paint.imageTransform === void 0 && (!paint.filters || Object.values(paint.filters).every((value) => value === 0)) && ["FILL", "FIT"].includes(((_a = paint.scaleMode) == null ? void 0 : _a.toUpperCase()) ?? "FILL") && Math.abs(paint.rotation ?? 0) <= EPSILON || paint.type === "SOLID" && paint.color && paint.color.r === 1 && paint.color.g === 1 && paint.color.b === 1 && (paint.color.a ?? 1) === 1);
  }) && part.children.every((child) => safeMask(child));
  if (!safeMask(mask, true)) return fail("\u8499\u7248\u5185\u90E8\u542B\u6709\u672A\u80FD\u8BC1\u660E\u7B49\u4EF7\u7684\u989C\u8272\u3001\u900F\u660E\u5EA6\u3001\u6548\u679C\u6216\u5D4C\u5957\u8499\u7248");
  return {
    candidate: { mask, tint: {
      ...fill.color,
      a: (fill.color.a ?? 1) * (fill.opacity ?? 1) * cover.opacity
    } },
    reason: "\u771F\u5B9E Alpha \u8499\u7248\u4E0E\u5355\u8272\u8986\u76D6\u5C42\u53EF\u4F7F\u7528\u7ECF\u9A8C\u8BC1\u7684\u767D\u8272\u5E95\u56FE\u548C\u5B9E\u4F8B Sprite Color"
  };
}
function verifyWhiteAlphaPng(contents) {
  try {
    if (contents.length < 33 || !contents.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return { valid: false, reason: "\u5E95\u56FE\u4E0D\u662F\u53EF\u9A8C\u8BC1\u7684 PNG\uFF0C\u4FDD\u5B88\u4F7F\u7528\u5B8C\u6574\u5408\u6210" };
    }
    const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
    if (!width || !height || width * height > 16e6) throw new Error("\u5E95\u56FE\u5C3A\u5BF8\u8D85\u8FC7\u5B89\u5168\u89E3\u7801\u8303\u56F4");
    const image = import_pngjs.PNG.sync.read(contents, { checkCRC: true, skipRescale: true });
    const maximum = Number(image.colorType) === 3 ? 255 : 2 ** image.depth - 1;
    let contributing = false;
    for (let i = 0; i < image.data.length; i += 4) {
      if (image.data[i + 3] === 0) continue;
      contributing = true;
      if (image.data[i] !== maximum || image.data[i + 1] !== maximum || image.data[i + 2] !== maximum) {
        return { valid: false, reason: "\u5E95\u56FE\u542B\u975E\u767D RGB\uFF0CSprite \u4E58\u8272\u4F1A\u504F\u6697\uFF0C\u4FDD\u5B88\u4F7F\u7528\u5B8C\u6574\u5408\u6210" };
      }
    }
    return { valid: contributing, reason: contributing ? "\u5DF2\u9010\u50CF\u7D20\u786E\u8BA4\u767D\u8272 RGB \u4E0E\u900F\u660E\u8F6E\u5ED3" : "\u5E95\u56FE\u5B8C\u5168\u900F\u660E\uFF0C\u65E0\u6CD5\u8BC1\u660E\u6709\u6548\u8F6E\u5ED3" };
  } catch (error) {
    return { valid: false, reason: `\u5E95\u56FE\u65E0\u6CD5\u5B89\u5168\u89E3\u7801\uFF1A${error.message}` };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  analyzeMaskTint,
  verifyWhiteAlphaPng
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9jaHVua3N0cmVhbS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ludGVybGFjZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhZXRoLXByZWRpY3Rvci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1hc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NvbnN0YW50cy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NyYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhcnNlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2JpdG1hcHBlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2Zvcm1hdC1ub3JtYWxpc2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLWFzeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvYml0cGFja2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvZmlsdGVyLXBhY2suanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXIuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItYXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLWluZmxhdGUuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLXJlYWRlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BuZy1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcG5nLmpzIiwgIi4uLy4uL3NvdXJjZS9maWdtYS9tYXNrLXRpbnQudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xubGV0IFN0cmVhbSA9IHJlcXVpcmUoXCJzdHJlYW1cIik7XG5cbmxldCBDaHVua1N0cmVhbSA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICgpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgdGhpcy5fYnVmZmVycyA9IFtdO1xuICB0aGlzLl9idWZmZXJlZCA9IDA7XG5cbiAgdGhpcy5fcmVhZHMgPSBbXTtcbiAgdGhpcy5fcGF1c2VkID0gZmFsc2U7XG5cbiAgdGhpcy5fZW5jb2RpbmcgPSBcInV0ZjhcIjtcbiAgdGhpcy53cml0YWJsZSA9IHRydWU7XG59KTtcbnV0aWwuaW5oZXJpdHMoQ2h1bmtTdHJlYW0sIFN0cmVhbSk7XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5yZWFkID0gZnVuY3Rpb24gKGxlbmd0aCwgY2FsbGJhY2spIHtcbiAgdGhpcy5fcmVhZHMucHVzaCh7XG4gICAgbGVuZ3RoOiBNYXRoLmFicyhsZW5ndGgpLCAvLyBpZiBsZW5ndGggPCAwIHRoZW4gYXQgbW9zdCB0aGlzIGxlbmd0aFxuICAgIGFsbG93TGVzczogbGVuZ3RoIDwgMCxcbiAgICBmdW5jOiBjYWxsYmFjayxcbiAgfSk7XG5cbiAgcHJvY2Vzcy5uZXh0VGljayhcbiAgICBmdW5jdGlvbiAoKSB7XG4gICAgICB0aGlzLl9wcm9jZXNzKCk7XG5cbiAgICAgIC8vIGl0cyBwYXVzZWQgYW5kIHRoZXJlIGlzIG5vdCBlbm91Z2h0IGRhdGEgdGhlbiBhc2sgZm9yIG1vcmVcbiAgICAgIGlmICh0aGlzLl9wYXVzZWQgJiYgdGhpcy5fcmVhZHMgJiYgdGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aGlzLl9wYXVzZWQgPSBmYWxzZTtcblxuICAgICAgICB0aGlzLmVtaXQoXCJkcmFpblwiKTtcbiAgICAgIH1cbiAgICB9LmJpbmQodGhpcylcbiAgKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhLCBlbmNvZGluZykge1xuICBpZiAoIXRoaXMud3JpdGFibGUpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBuZXcgRXJyb3IoXCJTdHJlYW0gbm90IHdyaXRhYmxlXCIpKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBsZXQgZGF0YUJ1ZmZlcjtcbiAgaWYgKEJ1ZmZlci5pc0J1ZmZlcihkYXRhKSkge1xuICAgIGRhdGFCdWZmZXIgPSBkYXRhO1xuICB9IGVsc2Uge1xuICAgIGRhdGFCdWZmZXIgPSBCdWZmZXIuZnJvbShkYXRhLCBlbmNvZGluZyB8fCB0aGlzLl9lbmNvZGluZyk7XG4gIH1cblxuICB0aGlzLl9idWZmZXJzLnB1c2goZGF0YUJ1ZmZlcik7XG4gIHRoaXMuX2J1ZmZlcmVkICs9IGRhdGFCdWZmZXIubGVuZ3RoO1xuXG4gIHRoaXMuX3Byb2Nlc3MoKTtcblxuICAvLyBvayBpZiB0aGVyZSBhcmUgbm8gbW9yZSByZWFkIHJlcXVlc3RzXG4gIGlmICh0aGlzLl9yZWFkcyAmJiB0aGlzLl9yZWFkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aGlzLl9wYXVzZWQgPSB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMud3JpdGFibGUgJiYgIXRoaXMuX3BhdXNlZDtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAoZGF0YSwgZW5jb2RpbmcpIHtcbiAgaWYgKGRhdGEpIHtcbiAgICB0aGlzLndyaXRlKGRhdGEsIGVuY29kaW5nKTtcbiAgfVxuXG4gIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcblxuICAvLyBhbHJlYWR5IGRlc3Ryb3llZFxuICBpZiAoIXRoaXMuX2J1ZmZlcnMpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBlbnF1ZXVlIG9yIGhhbmRsZSBlbmRcbiAgaWYgKHRoaXMuX2J1ZmZlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhpcy5fZW5kKCk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fYnVmZmVycy5wdXNoKG51bGwpO1xuICAgIHRoaXMuX3Byb2Nlc3MoKTtcbiAgfVxufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmRlc3Ryb3lTb29uID0gQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmVuZDtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9lbmQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLl9yZWFkcy5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgbmV3IEVycm9yKFwiVW5leHBlY3RlZCBlbmQgb2YgaW5wdXRcIikpO1xuICB9XG5cbiAgdGhpcy5kZXN0cm95KCk7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuZGVzdHJveSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLl9idWZmZXJzKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy53cml0YWJsZSA9IGZhbHNlO1xuICB0aGlzLl9yZWFkcyA9IG51bGw7XG4gIHRoaXMuX2J1ZmZlcnMgPSBudWxsO1xuXG4gIHRoaXMuZW1pdChcImNsb3NlXCIpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9wcm9jZXNzUmVhZEFsbG93aW5nTGVzcyA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gIC8vIG9rIHRoZXJlIGlzIGFueSBkYXRhIHNvIHRoYXQgd2UgY2FuIHNhdGlzZnkgdGhpcyByZXF1ZXN0XG4gIHRoaXMuX3JlYWRzLnNoaWZ0KCk7IC8vID09IHJlYWRcblxuICAvLyBmaXJzdCB3ZSBuZWVkIHRvIHBlZWsgaW50byBmaXJzdCBidWZmZXJcbiAgbGV0IHNtYWxsZXJCdWYgPSB0aGlzLl9idWZmZXJzWzBdO1xuXG4gIC8vIG9rIHRoZXJlIGlzIG1vcmUgZGF0YSB0aGFuIHdlIG5lZWRcbiAgaWYgKHNtYWxsZXJCdWYubGVuZ3RoID4gcmVhZC5sZW5ndGgpIHtcbiAgICB0aGlzLl9idWZmZXJlZCAtPSByZWFkLmxlbmd0aDtcbiAgICB0aGlzLl9idWZmZXJzWzBdID0gc21hbGxlckJ1Zi5zbGljZShyZWFkLmxlbmd0aCk7XG5cbiAgICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBzbWFsbGVyQnVmLnNsaWNlKDAsIHJlYWQubGVuZ3RoKSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gb2sgdGhpcyBpcyBsZXNzIHRoYW4gbWF4aW11bSBsZW5ndGggc28gdXNlIGl0IGFsbFxuICAgIHRoaXMuX2J1ZmZlcmVkIC09IHNtYWxsZXJCdWYubGVuZ3RoO1xuICAgIHRoaXMuX2J1ZmZlcnMuc2hpZnQoKTsgLy8gPT0gc21hbGxlckJ1ZlxuXG4gICAgcmVhZC5mdW5jLmNhbGwodGhpcywgc21hbGxlckJ1Zik7XG4gIH1cbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2Vzc1JlYWQgPSBmdW5jdGlvbiAocmVhZCkge1xuICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgbGV0IHBvcyA9IDA7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCBkYXRhID0gQnVmZmVyLmFsbG9jKHJlYWQubGVuZ3RoKTtcblxuICAvLyBjcmVhdGUgYnVmZmVyIGZvciBhbGwgZGF0YVxuICB3aGlsZSAocG9zIDwgcmVhZC5sZW5ndGgpIHtcbiAgICBsZXQgYnVmID0gdGhpcy5fYnVmZmVyc1tjb3VudCsrXTtcbiAgICBsZXQgbGVuID0gTWF0aC5taW4oYnVmLmxlbmd0aCwgcmVhZC5sZW5ndGggLSBwb3MpO1xuXG4gICAgYnVmLmNvcHkoZGF0YSwgcG9zLCAwLCBsZW4pO1xuICAgIHBvcyArPSBsZW47XG5cbiAgICAvLyBsYXN0IGJ1ZmZlciB3YXNuJ3QgdXNlZCBhbGwgc28ganVzdCBzbGljZSBpdCBhbmQgbGVhdmVcbiAgICBpZiAobGVuICE9PSBidWYubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9idWZmZXJzWy0tY291bnRdID0gYnVmLnNsaWNlKGxlbik7XG4gICAgfVxuICB9XG5cbiAgLy8gcmVtb3ZlIGFsbCB1c2VkIGJ1ZmZlcnNcbiAgaWYgKGNvdW50ID4gMCkge1xuICAgIHRoaXMuX2J1ZmZlcnMuc3BsaWNlKDAsIGNvdW50KTtcbiAgfVxuXG4gIHRoaXMuX2J1ZmZlcmVkIC09IHJlYWQubGVuZ3RoO1xuXG4gIHJlYWQuZnVuYy5jYWxsKHRoaXMsIGRhdGEpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9wcm9jZXNzID0gZnVuY3Rpb24gKCkge1xuICB0cnkge1xuICAgIC8vIGFzIGxvbmcgYXMgdGhlcmUgaXMgYW55IGRhdGEgYW5kIHJlYWQgcmVxdWVzdHNcbiAgICB3aGlsZSAodGhpcy5fYnVmZmVyZWQgPiAwICYmIHRoaXMuX3JlYWRzICYmIHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxldCByZWFkID0gdGhpcy5fcmVhZHNbMF07XG5cbiAgICAgIC8vIHJlYWQgYW55IGRhdGEgKGJ1dCBubyBtb3JlIHRoYW4gbGVuZ3RoKVxuICAgICAgaWYgKHJlYWQuYWxsb3dMZXNzKSB7XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NSZWFkQWxsb3dpbmdMZXNzKHJlYWQpO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLl9idWZmZXJlZCA+PSByZWFkLmxlbmd0aCkge1xuICAgICAgICAvLyBvayB3ZSBjYW4gbWVldCBzb21lIGV4cGVjdGF0aW9uc1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NSZWFkKHJlYWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gbm90IGVub3VnaHQgZGF0YSB0byBzYXRpc2Z5IGZpcnN0IHJlcXVlc3QgaW4gcXVldWVcbiAgICAgICAgLy8gc28gd2UgbmVlZCB0byB3YWl0IGZvciBtb3JlXG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLl9idWZmZXJzICYmICF0aGlzLndyaXRhYmxlKSB7XG4gICAgICB0aGlzLl9lbmQoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgZXgpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG4vLyBBZGFtIDdcbi8vICAgMCAxIDIgMyA0IDUgNiA3XG4vLyAwIHggNiA0IDYgeCA2IDQgNlxuLy8gMSA3IDcgNyA3IDcgNyA3IDdcbi8vIDIgNSA2IDUgNiA1IDYgNSA2XG4vLyAzIDcgNyA3IDcgNyA3IDcgN1xuLy8gNCAzIDYgNCA2IDMgNiA0IDZcbi8vIDUgNyA3IDcgNyA3IDcgNyA3XG4vLyA2IDUgNiA1IDYgNSA2IDUgNlxuLy8gNyA3IDcgNyA3IDcgNyA3IDdcblxubGV0IGltYWdlUGFzc2VzID0gW1xuICB7XG4gICAgLy8gcGFzcyAxIC0gMXB4XG4gICAgeDogWzBdLFxuICAgIHk6IFswXSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgMiAtIDFweFxuICAgIHg6IFs0XSxcbiAgICB5OiBbMF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDMgLSAycHhcbiAgICB4OiBbMCwgNF0sXG4gICAgeTogWzRdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyA0IC0gNHB4XG4gICAgeDogWzIsIDZdLFxuICAgIHk6IFswLCA0XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNSAtIDhweFxuICAgIHg6IFswLCAyLCA0LCA2XSxcbiAgICB5OiBbMiwgNl0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDYgLSAxNnB4XG4gICAgeDogWzEsIDMsIDUsIDddLFxuICAgIHk6IFswLCAyLCA0LCA2XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNyAtIDMycHhcbiAgICB4OiBbMCwgMSwgMiwgMywgNCwgNSwgNiwgN10sXG4gICAgeTogWzEsIDMsIDUsIDddLFxuICB9LFxuXTtcblxuZXhwb3J0cy5nZXRJbWFnZVBhc3NlcyA9IGZ1bmN0aW9uICh3aWR0aCwgaGVpZ2h0KSB7XG4gIGxldCBpbWFnZXMgPSBbXTtcbiAgbGV0IHhMZWZ0T3ZlciA9IHdpZHRoICUgODtcbiAgbGV0IHlMZWZ0T3ZlciA9IGhlaWdodCAlIDg7XG4gIGxldCB4UmVwZWF0cyA9ICh3aWR0aCAtIHhMZWZ0T3ZlcikgLyA4O1xuICBsZXQgeVJlcGVhdHMgPSAoaGVpZ2h0IC0geUxlZnRPdmVyKSAvIDg7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgaW1hZ2VQYXNzZXMubGVuZ3RoOyBpKyspIHtcbiAgICBsZXQgcGFzcyA9IGltYWdlUGFzc2VzW2ldO1xuICAgIGxldCBwYXNzV2lkdGggPSB4UmVwZWF0cyAqIHBhc3MueC5sZW5ndGg7XG4gICAgbGV0IHBhc3NIZWlnaHQgPSB5UmVwZWF0cyAqIHBhc3MueS5sZW5ndGg7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXNzLngubGVuZ3RoOyBqKyspIHtcbiAgICAgIGlmIChwYXNzLnhbal0gPCB4TGVmdE92ZXIpIHtcbiAgICAgICAgcGFzc1dpZHRoKys7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXNzLnkubGVuZ3RoOyBqKyspIHtcbiAgICAgIGlmIChwYXNzLnlbal0gPCB5TGVmdE92ZXIpIHtcbiAgICAgICAgcGFzc0hlaWdodCsrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwYXNzV2lkdGggPiAwICYmIHBhc3NIZWlnaHQgPiAwKSB7XG4gICAgICBpbWFnZXMucHVzaCh7IHdpZHRoOiBwYXNzV2lkdGgsIGhlaWdodDogcGFzc0hlaWdodCwgaW5kZXg6IGkgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBpbWFnZXM7XG59O1xuXG5leHBvcnRzLmdldEludGVybGFjZUl0ZXJhdG9yID0gZnVuY3Rpb24gKHdpZHRoKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoeCwgeSwgcGFzcykge1xuICAgIGxldCBvdXRlclhMZWZ0T3ZlciA9IHggJSBpbWFnZVBhc3Nlc1twYXNzXS54Lmxlbmd0aDtcbiAgICBsZXQgb3V0ZXJYID1cbiAgICAgICgoeCAtIG91dGVyWExlZnRPdmVyKSAvIGltYWdlUGFzc2VzW3Bhc3NdLngubGVuZ3RoKSAqIDggK1xuICAgICAgaW1hZ2VQYXNzZXNbcGFzc10ueFtvdXRlclhMZWZ0T3Zlcl07XG4gICAgbGV0IG91dGVyWUxlZnRPdmVyID0geSAlIGltYWdlUGFzc2VzW3Bhc3NdLnkubGVuZ3RoO1xuICAgIGxldCBvdXRlclkgPVxuICAgICAgKCh5IC0gb3V0ZXJZTGVmdE92ZXIpIC8gaW1hZ2VQYXNzZXNbcGFzc10ueS5sZW5ndGgpICogOCArXG4gICAgICBpbWFnZVBhc3Nlc1twYXNzXS55W291dGVyWUxlZnRPdmVyXTtcbiAgICByZXR1cm4gb3V0ZXJYICogNCArIG91dGVyWSAqIHdpZHRoICogNDtcbiAgfTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gcGFldGhQcmVkaWN0b3IobGVmdCwgYWJvdmUsIHVwTGVmdCkge1xuICBsZXQgcGFldGggPSBsZWZ0ICsgYWJvdmUgLSB1cExlZnQ7XG4gIGxldCBwTGVmdCA9IE1hdGguYWJzKHBhZXRoIC0gbGVmdCk7XG4gIGxldCBwQWJvdmUgPSBNYXRoLmFicyhwYWV0aCAtIGFib3ZlKTtcbiAgbGV0IHBVcExlZnQgPSBNYXRoLmFicyhwYWV0aCAtIHVwTGVmdCk7XG5cbiAgaWYgKHBMZWZ0IDw9IHBBYm92ZSAmJiBwTGVmdCA8PSBwVXBMZWZ0KSB7XG4gICAgcmV0dXJuIGxlZnQ7XG4gIH1cbiAgaWYgKHBBYm92ZSA8PSBwVXBMZWZ0KSB7XG4gICAgcmV0dXJuIGFib3ZlO1xuICB9XG4gIHJldHVybiB1cExlZnQ7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaW50ZXJsYWNlVXRpbHMgPSByZXF1aXJlKFwiLi9pbnRlcmxhY2VcIik7XG5sZXQgcGFldGhQcmVkaWN0b3IgPSByZXF1aXJlKFwiLi9wYWV0aC1wcmVkaWN0b3JcIik7XG5cbmZ1bmN0aW9uIGdldEJ5dGVXaWR0aCh3aWR0aCwgYnBwLCBkZXB0aCkge1xuICBsZXQgYnl0ZVdpZHRoID0gd2lkdGggKiBicHA7XG4gIGlmIChkZXB0aCAhPT0gOCkge1xuICAgIGJ5dGVXaWR0aCA9IE1hdGguY2VpbChieXRlV2lkdGggLyAoOCAvIGRlcHRoKSk7XG4gIH1cbiAgcmV0dXJuIGJ5dGVXaWR0aDtcbn1cblxubGV0IEZpbHRlciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChiaXRtYXBJbmZvLCBkZXBlbmRlbmNpZXMpIHtcbiAgbGV0IHdpZHRoID0gYml0bWFwSW5mby53aWR0aDtcbiAgbGV0IGhlaWdodCA9IGJpdG1hcEluZm8uaGVpZ2h0O1xuICBsZXQgaW50ZXJsYWNlID0gYml0bWFwSW5mby5pbnRlcmxhY2U7XG4gIGxldCBicHAgPSBiaXRtYXBJbmZvLmJwcDtcbiAgbGV0IGRlcHRoID0gYml0bWFwSW5mby5kZXB0aDtcblxuICB0aGlzLnJlYWQgPSBkZXBlbmRlbmNpZXMucmVhZDtcbiAgdGhpcy53cml0ZSA9IGRlcGVuZGVuY2llcy53cml0ZTtcbiAgdGhpcy5jb21wbGV0ZSA9IGRlcGVuZGVuY2llcy5jb21wbGV0ZTtcblxuICB0aGlzLl9pbWFnZUluZGV4ID0gMDtcbiAgdGhpcy5faW1hZ2VzID0gW107XG4gIGlmIChpbnRlcmxhY2UpIHtcbiAgICBsZXQgcGFzc2VzID0gaW50ZXJsYWNlVXRpbHMuZ2V0SW1hZ2VQYXNzZXMod2lkdGgsIGhlaWdodCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXNzZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHRoaXMuX2ltYWdlcy5wdXNoKHtcbiAgICAgICAgYnl0ZVdpZHRoOiBnZXRCeXRlV2lkdGgocGFzc2VzW2ldLndpZHRoLCBicHAsIGRlcHRoKSxcbiAgICAgICAgaGVpZ2h0OiBwYXNzZXNbaV0uaGVpZ2h0LFxuICAgICAgICBsaW5lSW5kZXg6IDAsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5faW1hZ2VzLnB1c2goe1xuICAgICAgYnl0ZVdpZHRoOiBnZXRCeXRlV2lkdGgod2lkdGgsIGJwcCwgZGVwdGgpLFxuICAgICAgaGVpZ2h0OiBoZWlnaHQsXG4gICAgICBsaW5lSW5kZXg6IDAsXG4gICAgfSk7XG4gIH1cblxuICAvLyB3aGVuIGZpbHRlcmluZyB0aGUgbGluZSB3ZSBsb29rIGF0IHRoZSBwaXhlbCB0byB0aGUgbGVmdFxuICAvLyB0aGUgc3BlYyBhbHNvIHNheXMgaXQgaXMgZG9uZSBvbiBhIGJ5dGUgbGV2ZWwgcmVnYXJkbGVzcyBvZiB0aGUgbnVtYmVyIG9mIHBpeGVsc1xuICAvLyBzbyBpZiB0aGUgZGVwdGggaXMgYnl0ZSBjb21wYXRpYmxlICg4IG9yIDE2KSB3ZSBzdWJ0cmFjdCB0aGUgYnBwIGluIG9yZGVyIHRvIGNvbXBhcmUgYmFja1xuICAvLyBhIHBpeGVsIHJhdGhlciB0aGFuIGp1c3QgYSBkaWZmZXJlbnQgYnl0ZSBwYXJ0LiBIb3dldmVyIGlmIHdlIGFyZSBzdWIgYnl0ZSwgd2UgaWdub3JlLlxuICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICB0aGlzLl94Q29tcGFyaXNvbiA9IGJwcDtcbiAgfSBlbHNlIGlmIChkZXB0aCA9PT0gMTYpIHtcbiAgICB0aGlzLl94Q29tcGFyaXNvbiA9IGJwcCAqIDI7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSAxO1xuICB9XG59KTtcblxuRmlsdGVyLnByb3RvdHlwZS5zdGFydCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKFxuICAgIHRoaXMuX2ltYWdlc1t0aGlzLl9pbWFnZUluZGV4XS5ieXRlV2lkdGggKyAxLFxuICAgIHRoaXMuX3JldmVyc2VGaWx0ZXJMaW5lLmJpbmQodGhpcylcbiAgKTtcbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTEgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgeENvbXBhcmlzb24gPSB0aGlzLl94Q29tcGFyaXNvbjtcbiAgbGV0IHhCaWdnZXJUaGFuID0geENvbXBhcmlzb24gLSAxO1xuXG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgcmF3Qnl0ZSA9IHJhd0RhdGFbMSArIHhdO1xuICAgIGxldCBmMUxlZnQgPSB4ID4geEJpZ2dlclRoYW4gPyB1bmZpbHRlcmVkTGluZVt4IC0geENvbXBhcmlzb25dIDogMDtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmMUxlZnQ7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTIgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgbGFzdExpbmUgPSB0aGlzLl9sYXN0TGluZTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjJVcCA9IGxhc3RMaW5lID8gbGFzdExpbmVbeF0gOiAwO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGYyVXA7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTMgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgeENvbXBhcmlzb24gPSB0aGlzLl94Q29tcGFyaXNvbjtcbiAgbGV0IHhCaWdnZXJUaGFuID0geENvbXBhcmlzb24gLSAxO1xuICBsZXQgbGFzdExpbmUgPSB0aGlzLl9sYXN0TGluZTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjNVcCA9IGxhc3RMaW5lID8gbGFzdExpbmVbeF0gOiAwO1xuICAgIGxldCBmM0xlZnQgPSB4ID4geEJpZ2dlclRoYW4gPyB1bmZpbHRlcmVkTGluZVt4IC0geENvbXBhcmlzb25dIDogMDtcbiAgICBsZXQgZjNBZGQgPSBNYXRoLmZsb29yKChmM0xlZnQgKyBmM1VwKSAvIDIpO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGYzQWRkO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGU0ID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGY0VXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICBsZXQgZjRMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGY0VXBMZWZ0ID0geCA+IHhCaWdnZXJUaGFuICYmIGxhc3RMaW5lID8gbGFzdExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGY0QWRkID0gcGFldGhQcmVkaWN0b3IoZjRMZWZ0LCBmNFVwLCBmNFVwTGVmdCk7XG4gICAgdW5maWx0ZXJlZExpbmVbeF0gPSByYXdCeXRlICsgZjRBZGQ7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3JldmVyc2VGaWx0ZXJMaW5lID0gZnVuY3Rpb24gKHJhd0RhdGEpIHtcbiAgbGV0IGZpbHRlciA9IHJhd0RhdGFbMF07XG4gIGxldCB1bmZpbHRlcmVkTGluZTtcbiAgbGV0IGN1cnJlbnRJbWFnZSA9IHRoaXMuX2ltYWdlc1t0aGlzLl9pbWFnZUluZGV4XTtcbiAgbGV0IGJ5dGVXaWR0aCA9IGN1cnJlbnRJbWFnZS5ieXRlV2lkdGg7XG5cbiAgaWYgKGZpbHRlciA9PT0gMCkge1xuICAgIHVuZmlsdGVyZWRMaW5lID0gcmF3RGF0YS5zbGljZSgxLCBieXRlV2lkdGggKyAxKTtcbiAgfSBlbHNlIHtcbiAgICB1bmZpbHRlcmVkTGluZSA9IEJ1ZmZlci5hbGxvYyhieXRlV2lkdGgpO1xuXG4gICAgc3dpdGNoIChmaWx0ZXIpIHtcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlMShyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTIocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICB0aGlzLl91bkZpbHRlclR5cGUzKHJhd0RhdGEsIHVuZmlsdGVyZWRMaW5lLCBieXRlV2lkdGgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgNDpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlNChyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnJlY29nbmlzZWQgZmlsdGVyIHR5cGUgLSBcIiArIGZpbHRlcik7XG4gICAgfVxuICB9XG5cbiAgdGhpcy53cml0ZSh1bmZpbHRlcmVkTGluZSk7XG5cbiAgY3VycmVudEltYWdlLmxpbmVJbmRleCsrO1xuICBpZiAoY3VycmVudEltYWdlLmxpbmVJbmRleCA+PSBjdXJyZW50SW1hZ2UuaGVpZ2h0KSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSBudWxsO1xuICAgIHRoaXMuX2ltYWdlSW5kZXgrKztcbiAgICBjdXJyZW50SW1hZ2UgPSB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF07XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSB1bmZpbHRlcmVkTGluZTtcbiAgfVxuXG4gIGlmIChjdXJyZW50SW1hZ2UpIHtcbiAgICAvLyByZWFkLCB1c2luZyB0aGUgYnl0ZSB3aWR0aCB0aGF0IG1heSBiZSBmcm9tIHRoZSBuZXcgY3VycmVudCBpbWFnZVxuICAgIHRoaXMucmVhZChjdXJyZW50SW1hZ2UuYnl0ZVdpZHRoICsgMSwgdGhpcy5fcmV2ZXJzZUZpbHRlckxpbmUuYmluZCh0aGlzKSk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSBudWxsO1xuICAgIHRoaXMuY29tcGxldGUoKTtcbiAgfVxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBDaHVua1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NodW5rc3RyZWFtXCIpO1xubGV0IEZpbHRlciA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZVwiKTtcblxubGV0IEZpbHRlckFzeW5jID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGJpdG1hcEluZm8pIHtcbiAgQ2h1bmtTdHJlYW0uY2FsbCh0aGlzKTtcblxuICBsZXQgYnVmZmVycyA9IFtdO1xuICBsZXQgdGhhdCA9IHRoaXM7XG4gIHRoaXMuX2ZpbHRlciA9IG5ldyBGaWx0ZXIoYml0bWFwSW5mbywge1xuICAgIHJlYWQ6IHRoaXMucmVhZC5iaW5kKHRoaXMpLFxuICAgIHdyaXRlOiBmdW5jdGlvbiAoYnVmZmVyKSB7XG4gICAgICBidWZmZXJzLnB1c2goYnVmZmVyKTtcbiAgICB9LFxuICAgIGNvbXBsZXRlOiBmdW5jdGlvbiAoKSB7XG4gICAgICB0aGF0LmVtaXQoXCJjb21wbGV0ZVwiLCBCdWZmZXIuY29uY2F0KGJ1ZmZlcnMpKTtcbiAgICB9LFxuICB9KTtcblxuICB0aGlzLl9maWx0ZXIuc3RhcnQoKTtcbn0pO1xudXRpbC5pbmhlcml0cyhGaWx0ZXJBc3luYywgQ2h1bmtTdHJlYW0pO1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgUE5HX1NJR05BVFVSRTogWzB4ODksIDB4NTAsIDB4NGUsIDB4NDcsIDB4MGQsIDB4MGEsIDB4MWEsIDB4MGFdLFxuXG4gIFRZUEVfSUhEUjogMHg0OTQ4NDQ1MixcbiAgVFlQRV9JRU5EOiAweDQ5NDU0ZTQ0LFxuICBUWVBFX0lEQVQ6IDB4NDk0NDQxNTQsXG4gIFRZUEVfUExURTogMHg1MDRjNTQ0NSxcbiAgVFlQRV90Uk5TOiAweDc0NTI0ZTUzLCAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIGNhbWVsY2FzZVxuICBUWVBFX2dBTUE6IDB4Njc0MTRkNDEsIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgY2FtZWxjYXNlXG5cbiAgLy8gY29sb3ItdHlwZSBiaXRzXG4gIENPTE9SVFlQRV9HUkFZU0NBTEU6IDAsXG4gIENPTE9SVFlQRV9QQUxFVFRFOiAxLFxuICBDT0xPUlRZUEVfQ09MT1I6IDIsXG4gIENPTE9SVFlQRV9BTFBIQTogNCwgLy8gZS5nLiBncmF5c2NhbGUgYW5kIGFscGhhXG5cbiAgLy8gY29sb3ItdHlwZSBjb21iaW5hdGlvbnNcbiAgQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1I6IDMsXG4gIENPTE9SVFlQRV9DT0xPUl9BTFBIQTogNixcblxuICBDT0xPUlRZUEVfVE9fQlBQX01BUDoge1xuICAgIDA6IDEsXG4gICAgMjogMyxcbiAgICAzOiAxLFxuICAgIDQ6IDIsXG4gICAgNjogNCxcbiAgfSxcblxuICBHQU1NQV9ESVZJU0lPTjogMTAwMDAwLFxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGNyY1RhYmxlID0gW107XG5cbihmdW5jdGlvbiAoKSB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMjU2OyBpKyspIHtcbiAgICBsZXQgY3VycmVudENyYyA9IGk7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCA4OyBqKyspIHtcbiAgICAgIGlmIChjdXJyZW50Q3JjICYgMSkge1xuICAgICAgICBjdXJyZW50Q3JjID0gMHhlZGI4ODMyMCBeIChjdXJyZW50Q3JjID4+PiAxKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN1cnJlbnRDcmMgPSBjdXJyZW50Q3JjID4+PiAxO1xuICAgICAgfVxuICAgIH1cbiAgICBjcmNUYWJsZVtpXSA9IGN1cnJlbnRDcmM7XG4gIH1cbn0pKCk7XG5cbmxldCBDcmNDYWxjdWxhdG9yID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLl9jcmMgPSAtMTtcbn0pO1xuXG5DcmNDYWxjdWxhdG9yLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YS5sZW5ndGg7IGkrKykge1xuICAgIHRoaXMuX2NyYyA9IGNyY1RhYmxlWyh0aGlzLl9jcmMgXiBkYXRhW2ldKSAmIDB4ZmZdIF4gKHRoaXMuX2NyYyA+Pj4gOCk7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5DcmNDYWxjdWxhdG9yLnByb3RvdHlwZS5jcmMzMiA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX2NyYyBeIC0xO1xufTtcblxuQ3JjQ2FsY3VsYXRvci5jcmMzMiA9IGZ1bmN0aW9uIChidWYpIHtcbiAgbGV0IGNyYyA9IC0xO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ1Zi5sZW5ndGg7IGkrKykge1xuICAgIGNyYyA9IGNyY1RhYmxlWyhjcmMgXiBidWZbaV0pICYgMHhmZl0gXiAoY3JjID4+PiA4KTtcbiAgfVxuICByZXR1cm4gY3JjIF4gLTE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IENyY0NhbGN1bGF0b3IgPSByZXF1aXJlKFwiLi9jcmNcIik7XG5cbmxldCBQYXJzZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucywgZGVwZW5kZW5jaWVzKSB7XG4gIHRoaXMuX29wdGlvbnMgPSBvcHRpb25zO1xuICBvcHRpb25zLmNoZWNrQ1JDID0gb3B0aW9ucy5jaGVja0NSQyAhPT0gZmFsc2U7XG5cbiAgdGhpcy5faGFzSUhEUiA9IGZhbHNlO1xuICB0aGlzLl9oYXNJRU5EID0gZmFsc2U7XG4gIHRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQgPSBmYWxzZTtcblxuICAvLyBpbnB1dCBmbGFncy9tZXRhZGF0YVxuICB0aGlzLl9wYWxldHRlID0gW107XG4gIHRoaXMuX2NvbG9yVHlwZSA9IDA7XG5cbiAgdGhpcy5fY2h1bmtzID0ge307XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9JSERSXSA9IHRoaXMuX2hhbmRsZUlIRFIuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX0lFTkRdID0gdGhpcy5faGFuZGxlSUVORC5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfSURBVF0gPSB0aGlzLl9oYW5kbGVJREFULmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9QTFRFXSA9IHRoaXMuX2hhbmRsZVBMVEUuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX3RSTlNdID0gdGhpcy5faGFuZGxlVFJOUy5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfZ0FNQV0gPSB0aGlzLl9oYW5kbGVHQU1BLmJpbmQodGhpcyk7XG5cbiAgdGhpcy5yZWFkID0gZGVwZW5kZW5jaWVzLnJlYWQ7XG4gIHRoaXMuZXJyb3IgPSBkZXBlbmRlbmNpZXMuZXJyb3I7XG4gIHRoaXMubWV0YWRhdGEgPSBkZXBlbmRlbmNpZXMubWV0YWRhdGE7XG4gIHRoaXMuZ2FtbWEgPSBkZXBlbmRlbmNpZXMuZ2FtbWE7XG4gIHRoaXMudHJhbnNDb2xvciA9IGRlcGVuZGVuY2llcy50cmFuc0NvbG9yO1xuICB0aGlzLnBhbGV0dGUgPSBkZXBlbmRlbmNpZXMucGFsZXR0ZTtcbiAgdGhpcy5wYXJzZWQgPSBkZXBlbmRlbmNpZXMucGFyc2VkO1xuICB0aGlzLmluZmxhdGVEYXRhID0gZGVwZW5kZW5jaWVzLmluZmxhdGVEYXRhO1xuICB0aGlzLmZpbmlzaGVkID0gZGVwZW5kZW5jaWVzLmZpbmlzaGVkO1xuICB0aGlzLnNpbXBsZVRyYW5zcGFyZW5jeSA9IGRlcGVuZGVuY2llcy5zaW1wbGVUcmFuc3BhcmVuY3k7XG4gIHRoaXMuaGVhZGVyc0ZpbmlzaGVkID0gZGVwZW5kZW5jaWVzLmhlYWRlcnNGaW5pc2hlZCB8fCBmdW5jdGlvbiAoKSB7fTtcbn0pO1xuXG5QYXJzZXIucHJvdG90eXBlLnN0YXJ0ID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLnJlYWQoY29uc3RhbnRzLlBOR19TSUdOQVRVUkUubGVuZ3RoLCB0aGlzLl9wYXJzZVNpZ25hdHVyZS5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlU2lnbmF0dXJlID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgbGV0IHNpZ25hdHVyZSA9IGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc2lnbmF0dXJlLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGRhdGFbaV0gIT09IHNpZ25hdHVyZVtpXSkge1xuICAgICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJJbnZhbGlkIGZpbGUgc2lnbmF0dXJlXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlQ2h1bmtCZWdpbiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIC8vIGNodW5rIGNvbnRlbnQgbGVuZ3RoXG4gIGxldCBsZW5ndGggPSBkYXRhLnJlYWRVSW50MzJCRSgwKTtcblxuICAvLyBjaHVuayB0eXBlXG4gIGxldCB0eXBlID0gZGF0YS5yZWFkVUludDMyQkUoNCk7XG4gIGxldCBuYW1lID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDQ7IGkgPCA4OyBpKyspIHtcbiAgICBuYW1lICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoZGF0YVtpXSk7XG4gIH1cblxuICAvL2NvbnNvbGUubG9nKCdjaHVuayAnLCBuYW1lLCBsZW5ndGgpO1xuXG4gIC8vIGNodW5rIGZsYWdzXG4gIGxldCBhbmNpbGxhcnkgPSBCb29sZWFuKGRhdGFbNF0gJiAweDIwKTsgLy8gb3IgY3JpdGljYWxcbiAgLy8gICAgcHJpdiA9IEJvb2xlYW4oZGF0YVs1XSAmIDB4MjApLCAvLyBvciBwdWJsaWNcbiAgLy8gICAgc2FmZVRvQ29weSA9IEJvb2xlYW4oZGF0YVs3XSAmIDB4MjApOyAvLyBvciB1bnNhZmVcblxuICBpZiAoIXRoaXMuX2hhc0lIRFIgJiYgdHlwZSAhPT0gY29uc3RhbnRzLlRZUEVfSUhEUikge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiRXhwZWN0ZWQgSUhEUiBvbiBiZWdnaW5pbmdcIikpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuX2NyYyA9IG5ldyBDcmNDYWxjdWxhdG9yKCk7XG4gIHRoaXMuX2NyYy53cml0ZShCdWZmZXIuZnJvbShuYW1lKSk7XG5cbiAgaWYgKHRoaXMuX2NodW5rc1t0eXBlXSkge1xuICAgIHJldHVybiB0aGlzLl9jaHVua3NbdHlwZV0obGVuZ3RoKTtcbiAgfVxuXG4gIGlmICghYW5jaWxsYXJ5KSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjcml0aWNhbCBjaHVuayB0eXBlIFwiICsgbmFtZSkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMucmVhZChsZW5ndGggKyA0LCB0aGlzLl9za2lwQ2h1bmsuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9za2lwQ2h1bmsgPSBmdW5jdGlvbiAoLypkYXRhKi8pIHtcbiAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUNodW5rRW5kID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLnJlYWQoNCwgdGhpcy5fcGFyc2VDaHVua0VuZC5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlQ2h1bmtFbmQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBsZXQgZmlsZUNyYyA9IGRhdGEucmVhZEludDMyQkUoMCk7XG4gIGxldCBjYWxjQ3JjID0gdGhpcy5fY3JjLmNyYzMyKCk7XG5cbiAgLy8gY2hlY2sgQ1JDXG4gIGlmICh0aGlzLl9vcHRpb25zLmNoZWNrQ1JDICYmIGNhbGNDcmMgIT09IGZpbGVDcmMpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIkNyYyBlcnJvciAtIFwiICsgZmlsZUNyYyArIFwiIC0gXCIgKyBjYWxjQ3JjKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLl9oYXNJRU5EKSB7XG4gICAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbiAgfVxufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlSUhEUiA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VJSERSLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlSUhEUiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICBsZXQgd2lkdGggPSBkYXRhLnJlYWRVSW50MzJCRSgwKTtcbiAgbGV0IGhlaWdodCA9IGRhdGEucmVhZFVJbnQzMkJFKDQpO1xuICBsZXQgZGVwdGggPSBkYXRhWzhdO1xuICBsZXQgY29sb3JUeXBlID0gZGF0YVs5XTsgLy8gYml0czogMSBwYWxldHRlLCAyIGNvbG9yLCA0IGFscGhhXG4gIGxldCBjb21wciA9IGRhdGFbMTBdO1xuICBsZXQgZmlsdGVyID0gZGF0YVsxMV07XG4gIGxldCBpbnRlcmxhY2UgPSBkYXRhWzEyXTtcblxuICAvLyBjb25zb2xlLmxvZygnICAgIHdpZHRoJywgd2lkdGgsICdoZWlnaHQnLCBoZWlnaHQsXG4gIC8vICAgICAnZGVwdGgnLCBkZXB0aCwgJ2NvbG9yVHlwZScsIGNvbG9yVHlwZSxcbiAgLy8gICAgICdjb21wcicsIGNvbXByLCAnZmlsdGVyJywgZmlsdGVyLCAnaW50ZXJsYWNlJywgaW50ZXJsYWNlXG4gIC8vICk7XG5cbiAgaWYgKFxuICAgIGRlcHRoICE9PSA4ICYmXG4gICAgZGVwdGggIT09IDQgJiZcbiAgICBkZXB0aCAhPT0gMiAmJlxuICAgIGRlcHRoICE9PSAxICYmXG4gICAgZGVwdGggIT09IDE2XG4gICkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgYml0IGRlcHRoIFwiICsgZGVwdGgpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCEoY29sb3JUeXBlIGluIGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUCkpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGNvbG9yIHR5cGVcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoY29tcHIgIT09IDApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGNvbXByZXNzaW9uIG1ldGhvZFwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChmaWx0ZXIgIT09IDApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGZpbHRlciBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoaW50ZXJsYWNlICE9PSAwICYmIGludGVybGFjZSAhPT0gMSkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgaW50ZXJsYWNlIG1ldGhvZFwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy5fY29sb3JUeXBlID0gY29sb3JUeXBlO1xuXG4gIGxldCBicHAgPSBjb25zdGFudHMuQ09MT1JUWVBFX1RPX0JQUF9NQVBbdGhpcy5fY29sb3JUeXBlXTtcblxuICB0aGlzLl9oYXNJSERSID0gdHJ1ZTtcblxuICB0aGlzLm1ldGFkYXRhKHtcbiAgICB3aWR0aDogd2lkdGgsXG4gICAgaGVpZ2h0OiBoZWlnaHQsXG4gICAgZGVwdGg6IGRlcHRoLFxuICAgIGludGVybGFjZTogQm9vbGVhbihpbnRlcmxhY2UpLFxuICAgIHBhbGV0dGU6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9QQUxFVFRFKSxcbiAgICBjb2xvcjogQm9vbGVhbihjb2xvclR5cGUgJiBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SKSxcbiAgICBhbHBoYTogQm9vbGVhbihjb2xvclR5cGUgJiBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBKSxcbiAgICBicHA6IGJwcCxcbiAgICBjb2xvclR5cGU6IGNvbG9yVHlwZSxcbiAgfSk7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZVBMVEUgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlUExURS5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVBMVEUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgbGV0IGVudHJpZXMgPSBNYXRoLmZsb29yKGRhdGEubGVuZ3RoIC8gMyk7XG4gIC8vIGNvbnNvbGUubG9nKCdQYWxldHRlOicsIGVudHJpZXMpO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZW50cmllczsgaSsrKSB7XG4gICAgdGhpcy5fcGFsZXR0ZS5wdXNoKFtkYXRhW2kgKiAzXSwgZGF0YVtpICogMyArIDFdLCBkYXRhW2kgKiAzICsgMl0sIDB4ZmZdKTtcbiAgfVxuXG4gIHRoaXMucGFsZXR0ZSh0aGlzLl9wYWxldHRlKTtcblxuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlVFJOUyA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5zaW1wbGVUcmFuc3BhcmVuY3koKTtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VUUk5TLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlVFJOUyA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICAvLyBwYWxldHRlXG4gIGlmICh0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURV9DT0xPUikge1xuICAgIGlmICh0aGlzLl9wYWxldHRlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJUcmFuc3BhcmVuY3kgY2h1bmsgbXVzdCBiZSBhZnRlciBwYWxldHRlXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGRhdGEubGVuZ3RoID4gdGhpcy5fcGFsZXR0ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiTW9yZSB0cmFuc3BhcmVudCBjb2xvcnMgdGhhbiBwYWxldHRlIHNpemVcIikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICAgIHRoaXMuX3BhbGV0dGVbaV1bM10gPSBkYXRhW2ldO1xuICAgIH1cbiAgICB0aGlzLnBhbGV0dGUodGhpcy5fcGFsZXR0ZSk7XG4gIH1cblxuICAvLyBmb3IgY29sb3JUeXBlIDAgKGdyYXlzY2FsZSkgYW5kIDIgKHJnYilcbiAgLy8gdGhlcmUgbWlnaHQgYmUgb25lIGdyYXkvY29sb3IgZGVmaW5lZCBhcyB0cmFuc3BhcmVudFxuICBpZiAodGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSkge1xuICAgIC8vIGdyZXksIDIgYnl0ZXNcbiAgICB0aGlzLnRyYW5zQ29sb3IoW2RhdGEucmVhZFVJbnQxNkJFKDApXSk7XG4gIH1cbiAgaWYgKHRoaXMuX2NvbG9yVHlwZSA9PT0gY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUikge1xuICAgIHRoaXMudHJhbnNDb2xvcihbXG4gICAgICBkYXRhLnJlYWRVSW50MTZCRSgwKSxcbiAgICAgIGRhdGEucmVhZFVJbnQxNkJFKDIpLFxuICAgICAgZGF0YS5yZWFkVUludDE2QkUoNCksXG4gICAgXSk7XG4gIH1cblxuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlR0FNQSA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VHQU1BLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlR0FNQSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcbiAgdGhpcy5nYW1tYShkYXRhLnJlYWRVSW50MzJCRSgwKSAvIGNvbnN0YW50cy5HQU1NQV9ESVZJU0lPTik7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlEQVQgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIGlmICghdGhpcy5fZW1pdHRlZEhlYWRlcnNGaW5pc2hlZCkge1xuICAgIHRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQgPSB0cnVlO1xuICAgIHRoaXMuaGVhZGVyc0ZpbmlzaGVkKCk7XG4gIH1cbiAgdGhpcy5yZWFkKC1sZW5ndGgsIHRoaXMuX3BhcnNlSURBVC5iaW5kKHRoaXMsIGxlbmd0aCkpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlSURBVCA9IGZ1bmN0aW9uIChsZW5ndGgsIGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIGlmIChcbiAgICB0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURV9DT0xPUiAmJlxuICAgIHRoaXMuX3BhbGV0dGUubGVuZ3RoID09PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIHBhbGV0dGUgbm90IGZvdW5kXCIpO1xuICB9XG5cbiAgdGhpcy5pbmZsYXRlRGF0YShkYXRhKTtcbiAgbGV0IGxlZnRPdmVyTGVuZ3RoID0gbGVuZ3RoIC0gZGF0YS5sZW5ndGg7XG5cbiAgaWYgKGxlZnRPdmVyTGVuZ3RoID4gMCkge1xuICAgIHRoaXMuX2hhbmRsZUlEQVQobGVmdE92ZXJMZW5ndGgpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG4gIH1cbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlFTkQgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlSUVORC5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlFTkQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgdGhpcy5faGFzSUVORCA9IHRydWU7XG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG5cbiAgaWYgKHRoaXMuZmluaXNoZWQpIHtcbiAgICB0aGlzLmZpbmlzaGVkKCk7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBpbnRlcmxhY2VVdGlscyA9IHJlcXVpcmUoXCIuL2ludGVybGFjZVwiKTtcblxubGV0IHBpeGVsQnBwTWFwcGVyID0gW1xuICAvLyAwIC0gZHVtbXkgZW50cnlcbiAgZnVuY3Rpb24gKCkge30sXG5cbiAgLy8gMSAtIExcbiAgLy8gMDogMCwgMTogMCwgMjogMCwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBkYXRhLCBweFBvcywgcmF3UG9zKSB7XG4gICAgaWYgKHJhd1BvcyA9PT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG5cbiAgICBsZXQgcGl4ZWwgPSBkYXRhW3Jhd1Bvc107XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IDB4ZmY7XG4gIH0sXG5cbiAgLy8gMiAtIExBXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDFcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAxID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgbGV0IHBpeGVsID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBkYXRhW3Jhd1BvcyArIDFdO1xuICB9LFxuXG4gIC8vIDMgLSBSR0JcbiAgLy8gMDogMCwgMTogMSwgMjogMiwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBkYXRhLCBweFBvcywgcmF3UG9zKSB7XG4gICAgaWYgKHJhd1BvcyArIDIgPj0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG5cbiAgICBweERhdGFbcHhQb3NdID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gZGF0YVtyYXdQb3MgKyAxXTtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IGRhdGFbcmF3UG9zICsgMl07XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSAweGZmO1xuICB9LFxuXG4gIC8vIDQgLSBSR0JBXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDNcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAzID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgcHhEYXRhW3B4UG9zXSA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IGRhdGFbcmF3UG9zICsgMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBkYXRhW3Jhd1BvcyArIDJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gZGF0YVtyYXdQb3MgKyAzXTtcbiAgfSxcbl07XG5cbmxldCBwaXhlbEJwcEN1c3RvbU1hcHBlciA9IFtcbiAgLy8gMCAtIGR1bW15IGVudHJ5XG4gIGZ1bmN0aW9uICgpIHt9LFxuXG4gIC8vIDEgLSBMXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KSB7XG4gICAgbGV0IHBpeGVsID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBtYXhCaXQ7XG4gIH0sXG5cbiAgLy8gMiAtIExBXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDFcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcykge1xuICAgIGxldCBwaXhlbCA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gcGl4ZWxEYXRhWzFdO1xuICB9LFxuXG4gIC8vIDMgLSBSR0JcbiAgLy8gMDogMCwgMTogMSwgMjogMiwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBwaXhlbERhdGEsIHB4UG9zLCBtYXhCaXQpIHtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWxEYXRhWzFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWxEYXRhWzJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gbWF4Qml0O1xuICB9LFxuXG4gIC8vIDQgLSBSR0JBXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDNcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcykge1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbERhdGFbMF07XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbERhdGFbMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbERhdGFbMl07XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBwaXhlbERhdGFbM107XG4gIH0sXG5dO1xuXG5mdW5jdGlvbiBiaXRSZXRyaWV2ZXIoZGF0YSwgZGVwdGgpIHtcbiAgbGV0IGxlZnRPdmVyID0gW107XG4gIGxldCBpID0gMDtcblxuICBmdW5jdGlvbiBzcGxpdCgpIHtcbiAgICBpZiAoaSA9PT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG4gICAgbGV0IGJ5dGUgPSBkYXRhW2ldO1xuICAgIGkrKztcbiAgICBsZXQgYnl0ZTgsIGJ5dGU3LCBieXRlNiwgYnl0ZTUsIGJ5dGU0LCBieXRlMywgYnl0ZTIsIGJ5dGUxO1xuICAgIHN3aXRjaCAoZGVwdGgpIHtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBkZXB0aFwiKTtcbiAgICAgIGNhc2UgMTY6XG4gICAgICAgIGJ5dGUyID0gZGF0YVtpXTtcbiAgICAgICAgaSsrO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKChieXRlIDw8IDgpICsgYnl0ZTIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgNDpcbiAgICAgICAgYnl0ZTIgPSBieXRlICYgMHgwZjtcbiAgICAgICAgYnl0ZTEgPSBieXRlID4+IDQ7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIGJ5dGU0ID0gYnl0ZSAmIDM7XG4gICAgICAgIGJ5dGUzID0gKGJ5dGUgPj4gMikgJiAzO1xuICAgICAgICBieXRlMiA9IChieXRlID4+IDQpICYgMztcbiAgICAgICAgYnl0ZTEgPSAoYnl0ZSA+PiA2KSAmIDM7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyLCBieXRlMywgYnl0ZTQpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgYnl0ZTggPSBieXRlICYgMTtcbiAgICAgICAgYnl0ZTcgPSAoYnl0ZSA+PiAxKSAmIDE7XG4gICAgICAgIGJ5dGU2ID0gKGJ5dGUgPj4gMikgJiAxO1xuICAgICAgICBieXRlNSA9IChieXRlID4+IDMpICYgMTtcbiAgICAgICAgYnl0ZTQgPSAoYnl0ZSA+PiA0KSAmIDE7XG4gICAgICAgIGJ5dGUzID0gKGJ5dGUgPj4gNSkgJiAxO1xuICAgICAgICBieXRlMiA9IChieXRlID4+IDYpICYgMTtcbiAgICAgICAgYnl0ZTEgPSAoYnl0ZSA+PiA3KSAmIDE7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyLCBieXRlMywgYnl0ZTQsIGJ5dGU1LCBieXRlNiwgYnl0ZTcsIGJ5dGU4KTtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBnZXQ6IGZ1bmN0aW9uIChjb3VudCkge1xuICAgICAgd2hpbGUgKGxlZnRPdmVyLmxlbmd0aCA8IGNvdW50KSB7XG4gICAgICAgIHNwbGl0KCk7XG4gICAgICB9XG4gICAgICBsZXQgcmV0dXJuZXIgPSBsZWZ0T3Zlci5zbGljZSgwLCBjb3VudCk7XG4gICAgICBsZWZ0T3ZlciA9IGxlZnRPdmVyLnNsaWNlKGNvdW50KTtcbiAgICAgIHJldHVybiByZXR1cm5lcjtcbiAgICB9LFxuICAgIHJlc2V0QWZ0ZXJMaW5lOiBmdW5jdGlvbiAoKSB7XG4gICAgICBsZWZ0T3Zlci5sZW5ndGggPSAwO1xuICAgIH0sXG4gICAgZW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoaSAhPT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZXh0cmEgZGF0YSBmb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYXBJbWFnZThCaXQoaW1hZ2UsIHB4RGF0YSwgZ2V0UHhQb3MsIGJwcCwgZGF0YSwgcmF3UG9zKSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICBsZXQgaW1hZ2VXaWR0aCA9IGltYWdlLndpZHRoO1xuICBsZXQgaW1hZ2VIZWlnaHQgPSBpbWFnZS5oZWlnaHQ7XG4gIGxldCBpbWFnZVBhc3MgPSBpbWFnZS5pbmRleDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBpbWFnZUhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCBpbWFnZVdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBweFBvcyA9IGdldFB4UG9zKHgsIHksIGltYWdlUGFzcyk7XG4gICAgICBwaXhlbEJwcE1hcHBlclticHBdKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcyk7XG4gICAgICByYXdQb3MgKz0gYnBwOyAvL2VzbGludC1kaXNhYmxlLWxpbmUgbm8tcGFyYW0tcmVhc3NpZ25cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJhd1Bvcztcbn1cblxuZnVuY3Rpb24gbWFwSW1hZ2VDdXN0b21CaXQoaW1hZ2UsIHB4RGF0YSwgZ2V0UHhQb3MsIGJwcCwgYml0cywgbWF4Qml0KSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICBsZXQgaW1hZ2VXaWR0aCA9IGltYWdlLndpZHRoO1xuICBsZXQgaW1hZ2VIZWlnaHQgPSBpbWFnZS5oZWlnaHQ7XG4gIGxldCBpbWFnZVBhc3MgPSBpbWFnZS5pbmRleDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBpbWFnZUhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCBpbWFnZVdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBwaXhlbERhdGEgPSBiaXRzLmdldChicHApO1xuICAgICAgbGV0IHB4UG9zID0gZ2V0UHhQb3MoeCwgeSwgaW1hZ2VQYXNzKTtcbiAgICAgIHBpeGVsQnBwQ3VzdG9tTWFwcGVyW2JwcF0ocHhEYXRhLCBwaXhlbERhdGEsIHB4UG9zLCBtYXhCaXQpO1xuICAgIH1cbiAgICBiaXRzLnJlc2V0QWZ0ZXJMaW5lKCk7XG4gIH1cbn1cblxuZXhwb3J0cy5kYXRhVG9CaXRNYXAgPSBmdW5jdGlvbiAoZGF0YSwgYml0bWFwSW5mbykge1xuICBsZXQgd2lkdGggPSBiaXRtYXBJbmZvLndpZHRoO1xuICBsZXQgaGVpZ2h0ID0gYml0bWFwSW5mby5oZWlnaHQ7XG4gIGxldCBkZXB0aCA9IGJpdG1hcEluZm8uZGVwdGg7XG4gIGxldCBicHAgPSBiaXRtYXBJbmZvLmJwcDtcbiAgbGV0IGludGVybGFjZSA9IGJpdG1hcEluZm8uaW50ZXJsYWNlO1xuICBsZXQgYml0cztcblxuICBpZiAoZGVwdGggIT09IDgpIHtcbiAgICBiaXRzID0gYml0UmV0cmlldmVyKGRhdGEsIGRlcHRoKTtcbiAgfVxuICBsZXQgcHhEYXRhO1xuICBpZiAoZGVwdGggPD0gOCkge1xuICAgIHB4RGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICB9IGVsc2Uge1xuICAgIHB4RGF0YSA9IG5ldyBVaW50MTZBcnJheSh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICB9XG4gIGxldCBtYXhCaXQgPSBNYXRoLnBvdygyLCBkZXB0aCkgLSAxO1xuICBsZXQgcmF3UG9zID0gMDtcbiAgbGV0IGltYWdlcztcbiAgbGV0IGdldFB4UG9zO1xuXG4gIGlmIChpbnRlcmxhY2UpIHtcbiAgICBpbWFnZXMgPSBpbnRlcmxhY2VVdGlscy5nZXRJbWFnZVBhc3Nlcyh3aWR0aCwgaGVpZ2h0KTtcbiAgICBnZXRQeFBvcyA9IGludGVybGFjZVV0aWxzLmdldEludGVybGFjZUl0ZXJhdG9yKHdpZHRoLCBoZWlnaHQpO1xuICB9IGVsc2Uge1xuICAgIGxldCBub25JbnRlcmxhY2VkUHhQb3MgPSAwO1xuICAgIGdldFB4UG9zID0gZnVuY3Rpb24gKCkge1xuICAgICAgbGV0IHJldHVybmVyID0gbm9uSW50ZXJsYWNlZFB4UG9zO1xuICAgICAgbm9uSW50ZXJsYWNlZFB4UG9zICs9IDQ7XG4gICAgICByZXR1cm4gcmV0dXJuZXI7XG4gICAgfTtcbiAgICBpbWFnZXMgPSBbeyB3aWR0aDogd2lkdGgsIGhlaWdodDogaGVpZ2h0IH1dO1xuICB9XG5cbiAgZm9yIChsZXQgaW1hZ2VJbmRleCA9IDA7IGltYWdlSW5kZXggPCBpbWFnZXMubGVuZ3RoOyBpbWFnZUluZGV4KyspIHtcbiAgICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICAgIHJhd1BvcyA9IG1hcEltYWdlOEJpdChcbiAgICAgICAgaW1hZ2VzW2ltYWdlSW5kZXhdLFxuICAgICAgICBweERhdGEsXG4gICAgICAgIGdldFB4UG9zLFxuICAgICAgICBicHAsXG4gICAgICAgIGRhdGEsXG4gICAgICAgIHJhd1Bvc1xuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWFwSW1hZ2VDdXN0b21CaXQoXG4gICAgICAgIGltYWdlc1tpbWFnZUluZGV4XSxcbiAgICAgICAgcHhEYXRhLFxuICAgICAgICBnZXRQeFBvcyxcbiAgICAgICAgYnBwLFxuICAgICAgICBiaXRzLFxuICAgICAgICBtYXhCaXRcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChkZXB0aCA9PT0gOCkge1xuICAgIGlmIChyYXdQb3MgIT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHRyYSBkYXRhIGZvdW5kXCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBiaXRzLmVuZCgpO1xuICB9XG5cbiAgcmV0dXJuIHB4RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmZ1bmN0aW9uIGRlUGFsZXR0ZShpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIHBhbGV0dGUpIHtcbiAgbGV0IHB4UG9zID0gMDtcbiAgLy8gdXNlIHZhbHVlcyBmcm9tIHBhbGV0dGVcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IGNvbG9yID0gcGFsZXR0ZVtpbmRhdGFbcHhQb3NdXTtcblxuICAgICAgaWYgKCFjb2xvcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbmRleCBcIiArIGluZGF0YVtweFBvc10gKyBcIiBub3QgaW4gcGFsZXR0ZVwiKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gY29sb3JbaV07XG4gICAgICB9XG4gICAgICBweFBvcyArPSA0O1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiByZXBsYWNlVHJhbnNwYXJlbnRDb2xvcihpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIHRyYW5zQ29sb3IpIHtcbiAgbGV0IHB4UG9zID0gMDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IG1ha2VUcmFucyA9IGZhbHNlO1xuXG4gICAgICBpZiAodHJhbnNDb2xvci5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgaWYgKHRyYW5zQ29sb3JbMF0gPT09IGluZGF0YVtweFBvc10pIHtcbiAgICAgICAgICBtYWtlVHJhbnMgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICB0cmFuc0NvbG9yWzBdID09PSBpbmRhdGFbcHhQb3NdICYmXG4gICAgICAgIHRyYW5zQ29sb3JbMV0gPT09IGluZGF0YVtweFBvcyArIDFdICYmXG4gICAgICAgIHRyYW5zQ29sb3JbMl0gPT09IGluZGF0YVtweFBvcyArIDJdXG4gICAgICApIHtcbiAgICAgICAgbWFrZVRyYW5zID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtYWtlVHJhbnMpIHtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgICBvdXRkYXRhW3B4UG9zICsgaV0gPSAwO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBweFBvcyArPSA0O1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBzY2FsZURlcHRoKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgZGVwdGgpIHtcbiAgbGV0IG1heE91dFNhbXBsZSA9IDI1NTtcbiAgbGV0IG1heEluU2FtcGxlID0gTWF0aC5wb3coMiwgZGVwdGgpIC0gMTtcbiAgbGV0IHB4UG9zID0gMDtcblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCB3aWR0aDsgeCsrKSB7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDQ7IGkrKykge1xuICAgICAgICBvdXRkYXRhW3B4UG9zICsgaV0gPSBNYXRoLmZsb29yKFxuICAgICAgICAgIChpbmRhdGFbcHhQb3MgKyBpXSAqIG1heE91dFNhbXBsZSkgLyBtYXhJblNhbXBsZSArIDAuNVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoaW5kYXRhLCBpbWFnZURhdGEsIHNraXBSZXNjYWxlID0gZmFsc2UpIHtcbiAgbGV0IGRlcHRoID0gaW1hZ2VEYXRhLmRlcHRoO1xuICBsZXQgd2lkdGggPSBpbWFnZURhdGEud2lkdGg7XG4gIGxldCBoZWlnaHQgPSBpbWFnZURhdGEuaGVpZ2h0O1xuICBsZXQgY29sb3JUeXBlID0gaW1hZ2VEYXRhLmNvbG9yVHlwZTtcbiAgbGV0IHRyYW5zQ29sb3IgPSBpbWFnZURhdGEudHJhbnNDb2xvcjtcbiAgbGV0IHBhbGV0dGUgPSBpbWFnZURhdGEucGFsZXR0ZTtcblxuICBsZXQgb3V0ZGF0YSA9IGluZGF0YTsgLy8gb25seSBkaWZmZXJlbnQgZm9yIDE2IGJpdHNcblxuICBpZiAoY29sb3JUeXBlID09PSAzKSB7XG4gICAgLy8gcGFsZXR0ZWRcbiAgICBkZVBhbGV0dGUoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCBwYWxldHRlKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAodHJhbnNDb2xvcikge1xuICAgICAgcmVwbGFjZVRyYW5zcGFyZW50Q29sb3IoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0cmFuc0NvbG9yKTtcbiAgICB9XG4gICAgLy8gaWYgaXQgbmVlZHMgc2NhbGluZ1xuICAgIGlmIChkZXB0aCAhPT0gOCAmJiAhc2tpcFJlc2NhbGUpIHtcbiAgICAgIC8vIGlmIHdlIG5lZWQgdG8gY2hhbmdlIHRoZSBidWZmZXIgc2l6ZVxuICAgICAgaWYgKGRlcHRoID09PSAxNikge1xuICAgICAgICBvdXRkYXRhID0gQnVmZmVyLmFsbG9jKHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICB9XG4gICAgICBzY2FsZURlcHRoKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgZGVwdGgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0ZGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xubGV0IENodW5rU3RyZWFtID0gcmVxdWlyZShcIi4vY2h1bmtzdHJlYW1cIik7XG5sZXQgRmlsdGVyQXN5bmMgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFyc2UtYXN5bmNcIik7XG5sZXQgUGFyc2VyID0gcmVxdWlyZShcIi4vcGFyc2VyXCIpO1xubGV0IGJpdG1hcHBlciA9IHJlcXVpcmUoXCIuL2JpdG1hcHBlclwiKTtcbmxldCBmb3JtYXROb3JtYWxpc2VyID0gcmVxdWlyZShcIi4vZm9ybWF0LW5vcm1hbGlzZXJcIik7XG5cbmxldCBQYXJzZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIENodW5rU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgdGhpcy5fcGFyc2VyID0gbmV3IFBhcnNlcihvcHRpb25zLCB7XG4gICAgcmVhZDogdGhpcy5yZWFkLmJpbmQodGhpcyksXG4gICAgZXJyb3I6IHRoaXMuX2hhbmRsZUVycm9yLmJpbmQodGhpcyksXG4gICAgbWV0YWRhdGE6IHRoaXMuX2hhbmRsZU1ldGFEYXRhLmJpbmQodGhpcyksXG4gICAgZ2FtbWE6IHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZ2FtbWFcIiksXG4gICAgcGFsZXR0ZTogdGhpcy5faGFuZGxlUGFsZXR0ZS5iaW5kKHRoaXMpLFxuICAgIHRyYW5zQ29sb3I6IHRoaXMuX2hhbmRsZVRyYW5zQ29sb3IuYmluZCh0aGlzKSxcbiAgICBmaW5pc2hlZDogdGhpcy5fZmluaXNoZWQuYmluZCh0aGlzKSxcbiAgICBpbmZsYXRlRGF0YTogdGhpcy5faW5mbGF0ZURhdGEuYmluZCh0aGlzKSxcbiAgICBzaW1wbGVUcmFuc3BhcmVuY3k6IHRoaXMuX3NpbXBsZVRyYW5zcGFyZW5jeS5iaW5kKHRoaXMpLFxuICAgIGhlYWRlcnNGaW5pc2hlZDogdGhpcy5faGVhZGVyc0ZpbmlzaGVkLmJpbmQodGhpcyksXG4gIH0pO1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgdGhpcy53cml0YWJsZSA9IHRydWU7XG5cbiAgdGhpcy5fcGFyc2VyLnN0YXJ0KCk7XG59KTtcbnV0aWwuaW5oZXJpdHMoUGFyc2VyQXN5bmMsIENodW5rU3RyZWFtKTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVFcnJvciA9IGZ1bmN0aW9uIChlcnIpIHtcbiAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgZXJyKTtcblxuICB0aGlzLndyaXRhYmxlID0gZmFsc2U7XG5cbiAgdGhpcy5kZXN0cm95KCk7XG5cbiAgaWYgKHRoaXMuX2luZmxhdGUgJiYgdGhpcy5faW5mbGF0ZS5kZXN0cm95KSB7XG4gICAgdGhpcy5faW5mbGF0ZS5kZXN0cm95KCk7XG4gIH1cblxuICBpZiAodGhpcy5fZmlsdGVyKSB7XG4gICAgdGhpcy5fZmlsdGVyLmRlc3Ryb3koKTtcbiAgICAvLyBGb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSB3aXRoIE5vZGUgNyBhbmQgYmVsb3cuXG4gICAgLy8gU3VwcHJlc3MgZXJyb3JzIGR1ZSB0byBfaW5mbGF0ZSBjYWxsaW5nIHdyaXRlKCkgZXZlbiBhZnRlclxuICAgIC8vIGl0J3MgZGVzdHJveSgpJ2VkLlxuICAgIHRoaXMuX2ZpbHRlci5vbihcImVycm9yXCIsIGZ1bmN0aW9uICgpIHt9KTtcbiAgfVxuXG4gIHRoaXMuZXJyb3JkID0gdHJ1ZTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faW5mbGF0ZURhdGEgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBpZiAoIXRoaXMuX2luZmxhdGUpIHtcbiAgICBpZiAodGhpcy5fYml0bWFwSW5mby5pbnRlcmxhY2UpIHtcbiAgICAgIHRoaXMuX2luZmxhdGUgPSB6bGliLmNyZWF0ZUluZmxhdGUoKTtcblxuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImVycm9yXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIikpO1xuICAgICAgdGhpcy5fZmlsdGVyLm9uKFwiY29tcGxldGVcIiwgdGhpcy5fY29tcGxldGUuYmluZCh0aGlzKSk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUucGlwZSh0aGlzLl9maWx0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgcm93U2l6ZSA9XG4gICAgICAgICgodGhpcy5fYml0bWFwSW5mby53aWR0aCAqXG4gICAgICAgICAgdGhpcy5fYml0bWFwSW5mby5icHAgKlxuICAgICAgICAgIHRoaXMuX2JpdG1hcEluZm8uZGVwdGggK1xuICAgICAgICAgIDcpID4+XG4gICAgICAgICAgMykgK1xuICAgICAgICAxO1xuICAgICAgbGV0IGltYWdlU2l6ZSA9IHJvd1NpemUgKiB0aGlzLl9iaXRtYXBJbmZvLmhlaWdodDtcbiAgICAgIGxldCBjaHVua1NpemUgPSBNYXRoLm1heChpbWFnZVNpemUsIHpsaWIuWl9NSU5fQ0hVTkspO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlID0gemxpYi5jcmVhdGVJbmZsYXRlKHsgY2h1bmtTaXplOiBjaHVua1NpemUgfSk7XG4gICAgICBsZXQgbGVmdFRvSW5mbGF0ZSA9IGltYWdlU2l6ZTtcblxuICAgICAgbGV0IGVtaXRFcnJvciA9IHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIik7XG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZXJyb3JcIiwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICBpZiAoIWxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBlbWl0RXJyb3IoZXJyKTtcbiAgICAgIH0pO1xuICAgICAgdGhpcy5fZmlsdGVyLm9uKFwiY29tcGxldGVcIiwgdGhpcy5fY29tcGxldGUuYmluZCh0aGlzKSk7XG5cbiAgICAgIGxldCBmaWx0ZXJXcml0ZSA9IHRoaXMuX2ZpbHRlci53cml0ZS5iaW5kKHRoaXMuX2ZpbHRlcik7XG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZGF0YVwiLCBmdW5jdGlvbiAoY2h1bmspIHtcbiAgICAgICAgaWYgKCFsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNodW5rLmxlbmd0aCA+IGxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgICBjaHVuayA9IGNodW5rLnNsaWNlKDAsIGxlZnRUb0luZmxhdGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGVmdFRvSW5mbGF0ZSAtPSBjaHVuay5sZW5ndGg7XG5cbiAgICAgICAgZmlsdGVyV3JpdGUoY2h1bmspO1xuICAgICAgfSk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUub24oXCJlbmRcIiwgdGhpcy5fZmlsdGVyLmVuZC5iaW5kKHRoaXMuX2ZpbHRlcikpO1xuICAgIH1cbiAgfVxuICB0aGlzLl9pbmZsYXRlLndyaXRlKGRhdGEpO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVNZXRhRGF0YSA9IGZ1bmN0aW9uIChtZXRhRGF0YSkge1xuICB0aGlzLl9tZXRhRGF0YSA9IG1ldGFEYXRhO1xuICB0aGlzLl9iaXRtYXBJbmZvID0gT2JqZWN0LmNyZWF0ZShtZXRhRGF0YSk7XG5cbiAgdGhpcy5fZmlsdGVyID0gbmV3IEZpbHRlckFzeW5jKHRoaXMuX2JpdG1hcEluZm8pO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVUcmFuc0NvbG9yID0gZnVuY3Rpb24gKHRyYW5zQ29sb3IpIHtcbiAgdGhpcy5fYml0bWFwSW5mby50cmFuc0NvbG9yID0gdHJhbnNDb2xvcjtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlUGFsZXR0ZSA9IGZ1bmN0aW9uIChwYWxldHRlKSB7XG4gIHRoaXMuX2JpdG1hcEluZm8ucGFsZXR0ZSA9IHBhbGV0dGU7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX3NpbXBsZVRyYW5zcGFyZW5jeSA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5fbWV0YURhdGEuYWxwaGEgPSB0cnVlO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oZWFkZXJzRmluaXNoZWQgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIFVwIHVudGlsIHRoaXMgcG9pbnQsIHdlIGRvbid0IGtub3cgaWYgd2UgaGF2ZSBhIHRSTlMgY2h1bmsgKGFscGhhKVxuICAvLyBzbyB3ZSBjYW4ndCBlbWl0IG1ldGFkYXRhIGFueSBlYXJsaWVyXG4gIHRoaXMuZW1pdChcIm1ldGFkYXRhXCIsIHRoaXMuX21ldGFEYXRhKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5fZmluaXNoZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmVycm9yZCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5faW5mbGF0ZSkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIFwiTm8gSW5mbGF0ZSBibG9ja1wiKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBubyBtb3JlIGRhdGEgdG8gaW5mbGF0ZVxuICAgIHRoaXMuX2luZmxhdGUuZW5kKCk7XG4gIH1cbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5fY29tcGxldGUgPSBmdW5jdGlvbiAoZmlsdGVyZWREYXRhKSB7XG4gIGlmICh0aGlzLmVycm9yZCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBub3JtYWxpc2VkQml0bWFwRGF0YTtcblxuICB0cnkge1xuICAgIGxldCBiaXRtYXBEYXRhID0gYml0bWFwcGVyLmRhdGFUb0JpdE1hcChmaWx0ZXJlZERhdGEsIHRoaXMuX2JpdG1hcEluZm8pO1xuXG4gICAgbm9ybWFsaXNlZEJpdG1hcERhdGEgPSBmb3JtYXROb3JtYWxpc2VyKFxuICAgICAgYml0bWFwRGF0YSxcbiAgICAgIHRoaXMuX2JpdG1hcEluZm8sXG4gICAgICB0aGlzLl9vcHRpb25zLnNraXBSZXNjYWxlXG4gICAgKTtcbiAgICBiaXRtYXBEYXRhID0gbnVsbDtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICB0aGlzLl9oYW5kbGVFcnJvcihleCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy5lbWl0KFwicGFyc2VkXCIsIG5vcm1hbGlzZWRCaXRtYXBEYXRhKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGRhdGFJbiwgd2lkdGgsIGhlaWdodCwgb3B0aW9ucykge1xuICBsZXQgb3V0SGFzQWxwaGEgPVxuICAgIFtjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLCBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBXS5pbmRleE9mKFxuICAgICAgb3B0aW9ucy5jb2xvclR5cGVcbiAgICApICE9PSAtMTtcbiAgaWYgKG9wdGlvbnMuY29sb3JUeXBlID09PSBvcHRpb25zLmlucHV0Q29sb3JUeXBlKSB7XG4gICAgbGV0IGJpZ0VuZGlhbiA9IChmdW5jdGlvbiAoKSB7XG4gICAgICBsZXQgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDIpO1xuICAgICAgbmV3IERhdGFWaWV3KGJ1ZmZlcikuc2V0SW50MTYoMCwgMjU2LCB0cnVlIC8qIGxpdHRsZUVuZGlhbiAqLyk7XG4gICAgICAvLyBJbnQxNkFycmF5IHVzZXMgdGhlIHBsYXRmb3JtJ3MgZW5kaWFubmVzcy5cbiAgICAgIHJldHVybiBuZXcgSW50MTZBcnJheShidWZmZXIpWzBdICE9PSAyNTY7XG4gICAgfSkoKTtcbiAgICAvLyBJZiBubyBuZWVkIHRvIGNvbnZlcnQgdG8gZ3JheXNjYWxlIGFuZCBhbHBoYSBpcyBwcmVzZW50L2Fic2VudCBpbiBib3RoLCB0YWtlIGEgZmFzdCByb3V0ZVxuICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4IHx8IChvcHRpb25zLmJpdERlcHRoID09PSAxNiAmJiBiaWdFbmRpYW4pKSB7XG4gICAgICByZXR1cm4gZGF0YUluO1xuICAgIH1cbiAgfVxuXG4gIC8vIG1hcCB0byBhIFVJbnQxNiBhcnJheSBpZiBkYXRhIGlzIDE2Yml0LCBmaXggZW5kaWFubmVzcyBiZWxvd1xuICBsZXQgZGF0YSA9IG9wdGlvbnMuYml0RGVwdGggIT09IDE2ID8gZGF0YUluIDogbmV3IFVpbnQxNkFycmF5KGRhdGFJbi5idWZmZXIpO1xuXG4gIGxldCBtYXhWYWx1ZSA9IDI1NTtcbiAgbGV0IGluQnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW29wdGlvbnMuaW5wdXRDb2xvclR5cGVdO1xuICBpZiAoaW5CcHAgPT09IDQgJiYgIW9wdGlvbnMuaW5wdXRIYXNBbHBoYSkge1xuICAgIGluQnBwID0gMztcbiAgfVxuICBsZXQgb3V0QnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW29wdGlvbnMuY29sb3JUeXBlXTtcbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDE2KSB7XG4gICAgbWF4VmFsdWUgPSA2NTUzNTtcbiAgICBvdXRCcHAgKj0gMjtcbiAgfVxuICBsZXQgb3V0RGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIG91dEJwcCk7XG5cbiAgbGV0IGluSW5kZXggPSAwO1xuICBsZXQgb3V0SW5kZXggPSAwO1xuXG4gIGxldCBiZ0NvbG9yID0gb3B0aW9ucy5iZ0NvbG9yIHx8IHt9O1xuICBpZiAoYmdDb2xvci5yZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGJnQ29sb3IucmVkID0gbWF4VmFsdWU7XG4gIH1cbiAgaWYgKGJnQ29sb3IuZ3JlZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIGJnQ29sb3IuZ3JlZW4gPSBtYXhWYWx1ZTtcbiAgfVxuICBpZiAoYmdDb2xvci5ibHVlID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLmJsdWUgPSBtYXhWYWx1ZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldFJHQkEoKSB7XG4gICAgbGV0IHJlZDtcbiAgICBsZXQgZ3JlZW47XG4gICAgbGV0IGJsdWU7XG4gICAgbGV0IGFscGhhID0gbWF4VmFsdWU7XG4gICAgc3dpdGNoIChvcHRpb25zLmlucHV0Q29sb3JUeXBlKSB7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE6XG4gICAgICAgIGFscGhhID0gZGF0YVtpbkluZGV4ICsgM107XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIGJsdWUgPSBkYXRhW2luSW5kZXggKyAyXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1I6XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIGJsdWUgPSBkYXRhW2luSW5kZXggKyAyXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEE6XG4gICAgICAgIGFscGhhID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gcmVkO1xuICAgICAgICBibHVlID0gcmVkO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEU6XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gcmVkO1xuICAgICAgICBibHVlID0gcmVkO1xuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcImlucHV0IGNvbG9yIHR5cGU6XCIgK1xuICAgICAgICAgICAgb3B0aW9ucy5pbnB1dENvbG9yVHlwZSArXG4gICAgICAgICAgICBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICAgICApO1xuICAgIH1cblxuICAgIGlmIChvcHRpb25zLmlucHV0SGFzQWxwaGEpIHtcbiAgICAgIGlmICghb3V0SGFzQWxwaGEpIHtcbiAgICAgICAgYWxwaGEgLz0gbWF4VmFsdWU7XG4gICAgICAgIHJlZCA9IE1hdGgubWluKFxuICAgICAgICAgIE1hdGgubWF4KE1hdGgucm91bmQoKDEgLSBhbHBoYSkgKiBiZ0NvbG9yLnJlZCArIGFscGhhICogcmVkKSwgMCksXG4gICAgICAgICAgbWF4VmFsdWVcbiAgICAgICAgKTtcbiAgICAgICAgZ3JlZW4gPSBNYXRoLm1pbihcbiAgICAgICAgICBNYXRoLm1heChNYXRoLnJvdW5kKCgxIC0gYWxwaGEpICogYmdDb2xvci5ncmVlbiArIGFscGhhICogZ3JlZW4pLCAwKSxcbiAgICAgICAgICBtYXhWYWx1ZVxuICAgICAgICApO1xuICAgICAgICBibHVlID0gTWF0aC5taW4oXG4gICAgICAgICAgTWF0aC5tYXgoTWF0aC5yb3VuZCgoMSAtIGFscGhhKSAqIGJnQ29sb3IuYmx1ZSArIGFscGhhICogYmx1ZSksIDApLFxuICAgICAgICAgIG1heFZhbHVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHJlZDogcmVkLCBncmVlbjogZ3JlZW4sIGJsdWU6IGJsdWUsIGFscGhhOiBhbHBoYSB9O1xuICB9XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IHJnYmEgPSBnZXRSR0JBKGRhdGEsIGluSW5kZXgpO1xuXG4gICAgICBzd2l0Y2ggKG9wdGlvbnMuY29sb3JUeXBlKSB7XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTpcbiAgICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SOlxuICAgICAgICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4KSB7XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4XSA9IHJnYmEucmVkO1xuICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleCArIDFdID0gcmdiYS5ncmVlbjtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAyXSA9IHJnYmEuYmx1ZTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgM10gPSByZ2JhLmFscGhhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5yZWQsIG91dEluZGV4KTtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShyZ2JhLmdyZWVuLCBvdXRJbmRleCArIDIpO1xuICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYmx1ZSwgb3V0SW5kZXggKyA0KTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5hbHBoYSwgb3V0SW5kZXggKyA2KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQTpcbiAgICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRToge1xuICAgICAgICAgIC8vIENvbnZlcnQgdG8gZ3JheXNjYWxlIGFuZCBhbHBoYVxuICAgICAgICAgIGxldCBncmF5c2NhbGUgPSAocmdiYS5yZWQgKyByZ2JhLmdyZWVuICsgcmdiYS5ibHVlKSAvIDM7XG4gICAgICAgICAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDgpIHtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXhdID0gZ3JheXNjYWxlO1xuICAgICAgICAgICAgaWYgKG91dEhhc0FscGhhKSB7XG4gICAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAxXSA9IHJnYmEuYWxwaGE7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShncmF5c2NhbGUsIG91dEluZGV4KTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5hbHBoYSwgb3V0SW5kZXggKyAyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgY29sb3IgVHlwZSBcIiArIG9wdGlvbnMuY29sb3JUeXBlKTtcbiAgICAgIH1cblxuICAgICAgaW5JbmRleCArPSBpbkJwcDtcbiAgICAgIG91dEluZGV4ICs9IG91dEJwcDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb3V0RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBwYWV0aFByZWRpY3RvciA9IHJlcXVpcmUoXCIuL3BhZXRoLXByZWRpY3RvclwiKTtcblxuZnVuY3Rpb24gZmlsdGVyTm9uZShweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1Bvcykge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHB4RGF0YVtweFBvcyArIHhdO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bU5vbmUocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoKSB7XG4gIGxldCBzdW0gPSAwO1xuICBsZXQgbGVuZ3RoID0gcHhQb3MgKyBieXRlV2lkdGg7XG5cbiAgZm9yIChsZXQgaSA9IHB4UG9zOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBzdW0gKz0gTWF0aC5hYnMocHhEYXRhW2ldKTtcbiAgfVxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdWIocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCkge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBsZWZ0O1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1TdWIocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIGxlZnQ7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmZ1bmN0aW9uIGZpbHRlclVwKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zKSB7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gdXA7XG5cbiAgICByYXdEYXRhW3Jhd1BvcyArIHhdID0gdmFsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bVVwKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCkge1xuICBsZXQgc3VtID0gMDtcbiAgbGV0IGxlbmd0aCA9IHB4UG9zICsgYnl0ZVdpZHRoO1xuICBmb3IgKGxldCB4ID0gcHhQb3M7IHggPCBsZW5ndGg7IHgrKykge1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVt4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVt4XSAtIHVwO1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJBdmcocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCkge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gKChsZWZ0ICsgdXApID4+IDEpO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1BdmcocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVtweFBvcyArIHggLSBieXRlV2lkdGhdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSAoKGxlZnQgKyB1cCkgPj4gMSk7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmZ1bmN0aW9uIGZpbHRlclBhZXRoKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB1cGxlZnQgPVxuICAgICAgcHhQb3MgPiAwICYmIHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIChieXRlV2lkdGggKyBicHApXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gcGFldGhQcmVkaWN0b3IobGVmdCwgdXAsIHVwbGVmdCk7XG5cbiAgICByYXdEYXRhW3Jhd1BvcyArIHhdID0gdmFsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bVBhZXRoKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHVwbGVmdCA9XG4gICAgICBweFBvcyA+IDAgJiYgeCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gKGJ5dGVXaWR0aCArIGJwcCldIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBwYWV0aFByZWRpY3RvcihsZWZ0LCB1cCwgdXBsZWZ0KTtcblxuICAgIHN1bSArPSBNYXRoLmFicyh2YWwpO1xuICB9XG5cbiAgcmV0dXJuIHN1bTtcbn1cblxubGV0IGZpbHRlcnMgPSB7XG4gIDA6IGZpbHRlck5vbmUsXG4gIDE6IGZpbHRlclN1YixcbiAgMjogZmlsdGVyVXAsXG4gIDM6IGZpbHRlckF2ZyxcbiAgNDogZmlsdGVyUGFldGgsXG59O1xuXG5sZXQgZmlsdGVyU3VtcyA9IHtcbiAgMDogZmlsdGVyU3VtTm9uZSxcbiAgMTogZmlsdGVyU3VtU3ViLFxuICAyOiBmaWx0ZXJTdW1VcCxcbiAgMzogZmlsdGVyU3VtQXZnLFxuICA0OiBmaWx0ZXJTdW1QYWV0aCxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHB4RGF0YSwgd2lkdGgsIGhlaWdodCwgb3B0aW9ucywgYnBwKSB7XG4gIGxldCBmaWx0ZXJUeXBlcztcbiAgaWYgKCEoXCJmaWx0ZXJUeXBlXCIgaW4gb3B0aW9ucykgfHwgb3B0aW9ucy5maWx0ZXJUeXBlID09PSAtMSkge1xuICAgIGZpbHRlclR5cGVzID0gWzAsIDEsIDIsIDMsIDRdO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmZpbHRlclR5cGUgPT09IFwibnVtYmVyXCIpIHtcbiAgICBmaWx0ZXJUeXBlcyA9IFtvcHRpb25zLmZpbHRlclR5cGVdO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBmaWx0ZXIgdHlwZXNcIik7XG4gIH1cblxuICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gMTYpIHtcbiAgICBicHAgKj0gMjtcbiAgfVxuICBsZXQgYnl0ZVdpZHRoID0gd2lkdGggKiBicHA7XG4gIGxldCByYXdQb3MgPSAwO1xuICBsZXQgcHhQb3MgPSAwO1xuICBsZXQgcmF3RGF0YSA9IEJ1ZmZlci5hbGxvYygoYnl0ZVdpZHRoICsgMSkgKiBoZWlnaHQpO1xuXG4gIGxldCBzZWwgPSBmaWx0ZXJUeXBlc1swXTtcblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgaWYgKGZpbHRlclR5cGVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIC8vIGZpbmQgYmVzdCBmaWx0ZXIgZm9yIHRoaXMgbGluZSAod2l0aCBsb3dlc3Qgc3VtIG9mIHZhbHVlcylcbiAgICAgIGxldCBtaW4gPSBJbmZpbml0eTtcblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWx0ZXJUeXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBsZXQgc3VtID0gZmlsdGVyU3Vtc1tmaWx0ZXJUeXBlc1tpXV0ocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApO1xuICAgICAgICBpZiAoc3VtIDwgbWluKSB7XG4gICAgICAgICAgc2VsID0gZmlsdGVyVHlwZXNbaV07XG4gICAgICAgICAgbWluID0gc3VtO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmF3RGF0YVtyYXdQb3NdID0gc2VsO1xuICAgIHJhd1BvcysrO1xuICAgIGZpbHRlcnNbc2VsXShweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1BvcywgYnBwKTtcbiAgICByYXdQb3MgKz0gYnl0ZVdpZHRoO1xuICAgIHB4UG9zICs9IGJ5dGVXaWR0aDtcbiAgfVxuICByZXR1cm4gcmF3RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgQ3JjU3RyZWFtID0gcmVxdWlyZShcIi4vY3JjXCIpO1xubGV0IGJpdFBhY2tlciA9IHJlcXVpcmUoXCIuL2JpdHBhY2tlclwiKTtcbmxldCBmaWx0ZXIgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFja1wiKTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5cbmxldCBQYWNrZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucykge1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcblxuICBvcHRpb25zLmRlZmxhdGVDaHVua1NpemUgPSBvcHRpb25zLmRlZmxhdGVDaHVua1NpemUgfHwgMzIgKiAxMDI0O1xuICBvcHRpb25zLmRlZmxhdGVMZXZlbCA9XG4gICAgb3B0aW9ucy5kZWZsYXRlTGV2ZWwgIT0gbnVsbCA/IG9wdGlvbnMuZGVmbGF0ZUxldmVsIDogOTtcbiAgb3B0aW9ucy5kZWZsYXRlU3RyYXRlZ3kgPVxuICAgIG9wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5ICE9IG51bGwgPyBvcHRpb25zLmRlZmxhdGVTdHJhdGVneSA6IDM7XG4gIG9wdGlvbnMuaW5wdXRIYXNBbHBoYSA9XG4gICAgb3B0aW9ucy5pbnB1dEhhc0FscGhhICE9IG51bGwgPyBvcHRpb25zLmlucHV0SGFzQWxwaGEgOiB0cnVlO1xuICBvcHRpb25zLmRlZmxhdGVGYWN0b3J5ID0gb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSB8fCB6bGliLmNyZWF0ZURlZmxhdGU7XG4gIG9wdGlvbnMuYml0RGVwdGggPSBvcHRpb25zLmJpdERlcHRoIHx8IDg7XG4gIC8vIFRoaXMgaXMgb3V0cHV0Q29sb3JUeXBlXG4gIG9wdGlvbnMuY29sb3JUeXBlID1cbiAgICB0eXBlb2Ygb3B0aW9ucy5jb2xvclR5cGUgPT09IFwibnVtYmVyXCJcbiAgICAgID8gb3B0aW9ucy5jb2xvclR5cGVcbiAgICAgIDogY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTtcbiAgb3B0aW9ucy5pbnB1dENvbG9yVHlwZSA9XG4gICAgdHlwZW9mIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgPT09IFwibnVtYmVyXCJcbiAgICAgID8gb3B0aW9ucy5pbnB1dENvbG9yVHlwZVxuICAgICAgOiBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBO1xuXG4gIGlmIChcbiAgICBbXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSxcbiAgICBdLmluZGV4T2Yob3B0aW9ucy5jb2xvclR5cGUpID09PSAtMVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIm9wdGlvbiBjb2xvciB0eXBlOlwiICsgb3B0aW9ucy5jb2xvclR5cGUgKyBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIFtcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfR1JBWVNDQUxFLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUixcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEEsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBLFxuICAgIF0uaW5kZXhPZihvcHRpb25zLmlucHV0Q29sb3JUeXBlKSA9PT0gLTFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gaW5wdXQgY29sb3IgdHlwZTpcIiArXG4gICAgICAgIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgK1xuICAgICAgICBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICk7XG4gIH1cbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggIT09IDggJiYgb3B0aW9ucy5iaXREZXB0aCAhPT0gMTYpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIm9wdGlvbiBiaXQgZGVwdGg6XCIgKyBvcHRpb25zLmJpdERlcHRoICsgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG59KTtcblxuUGFja2VyLnByb3RvdHlwZS5nZXREZWZsYXRlT3B0aW9ucyA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHtcbiAgICBjaHVua1NpemU6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZUNodW5rU2l6ZSxcbiAgICBsZXZlbDogdGhpcy5fb3B0aW9ucy5kZWZsYXRlTGV2ZWwsXG4gICAgc3RyYXRlZ3k6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5LFxuICB9O1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5jcmVhdGVEZWZsYXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSh0aGlzLmdldERlZmxhdGVPcHRpb25zKCkpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5maWx0ZXJEYXRhID0gZnVuY3Rpb24gKGRhdGEsIHdpZHRoLCBoZWlnaHQpIHtcbiAgLy8gY29udmVydCB0byBjb3JyZWN0IGZvcm1hdCBmb3IgZmlsdGVyaW5nIChlLmcuIHJpZ2h0IGJwcCBhbmQgYml0IGRlcHRoKVxuICBsZXQgcGFja2VkRGF0YSA9IGJpdFBhY2tlcihkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0aGlzLl9vcHRpb25zKTtcblxuICAvLyBmaWx0ZXIgcGl4ZWwgZGF0YVxuICBsZXQgYnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW3RoaXMuX29wdGlvbnMuY29sb3JUeXBlXTtcbiAgbGV0IGZpbHRlcmVkRGF0YSA9IGZpbHRlcihwYWNrZWREYXRhLCB3aWR0aCwgaGVpZ2h0LCB0aGlzLl9vcHRpb25zLCBicHApO1xuICByZXR1cm4gZmlsdGVyZWREYXRhO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5fcGFja0NodW5rID0gZnVuY3Rpb24gKHR5cGUsIGRhdGEpIHtcbiAgbGV0IGxlbiA9IGRhdGEgPyBkYXRhLmxlbmd0aCA6IDA7XG4gIGxldCBidWYgPSBCdWZmZXIuYWxsb2MobGVuICsgMTIpO1xuXG4gIGJ1Zi53cml0ZVVJbnQzMkJFKGxlbiwgMCk7XG4gIGJ1Zi53cml0ZVVJbnQzMkJFKHR5cGUsIDQpO1xuXG4gIGlmIChkYXRhKSB7XG4gICAgZGF0YS5jb3B5KGJ1ZiwgOCk7XG4gIH1cblxuICBidWYud3JpdGVJbnQzMkJFKFxuICAgIENyY1N0cmVhbS5jcmMzMihidWYuc2xpY2UoNCwgYnVmLmxlbmd0aCAtIDQpKSxcbiAgICBidWYubGVuZ3RoIC0gNFxuICApO1xuICByZXR1cm4gYnVmO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrR0FNQSA9IGZ1bmN0aW9uIChnYW1tYSkge1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKDQpO1xuICBidWYud3JpdGVVSW50MzJCRShNYXRoLmZsb29yKGdhbW1hICogY29uc3RhbnRzLkdBTU1BX0RJVklTSU9OKSwgMCk7XG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfZ0FNQSwgYnVmKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0lIRFIgPSBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKDEzKTtcbiAgYnVmLndyaXRlVUludDMyQkUod2lkdGgsIDApO1xuICBidWYud3JpdGVVSW50MzJCRShoZWlnaHQsIDQpO1xuICBidWZbOF0gPSB0aGlzLl9vcHRpb25zLmJpdERlcHRoOyAvLyBCaXQgZGVwdGhcbiAgYnVmWzldID0gdGhpcy5fb3B0aW9ucy5jb2xvclR5cGU7IC8vIGNvbG9yVHlwZVxuICBidWZbMTBdID0gMDsgLy8gY29tcHJlc3Npb25cbiAgYnVmWzExXSA9IDA7IC8vIGZpbHRlclxuICBidWZbMTJdID0gMDsgLy8gaW50ZXJsYWNlXG5cbiAgcmV0dXJuIHRoaXMuX3BhY2tDaHVuayhjb25zdGFudHMuVFlQRV9JSERSLCBidWYpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrSURBVCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfSURBVCwgZGF0YSk7XG59O1xuXG5QYWNrZXIucHJvdG90eXBlLnBhY2tJRU5EID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX0lFTkQsIG51bGwpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xubGV0IGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcbmxldCBQYWNrZXIgPSByZXF1aXJlKFwiLi9wYWNrZXJcIik7XG5cbmxldCBQYWNrZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChvcHQpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgbGV0IG9wdGlvbnMgPSBvcHQgfHwge307XG5cbiAgdGhpcy5fcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcbiAgdGhpcy5fZGVmbGF0ZSA9IHRoaXMuX3BhY2tlci5jcmVhdGVEZWZsYXRlKCk7XG5cbiAgdGhpcy5yZWFkYWJsZSA9IHRydWU7XG59KTtcbnV0aWwuaW5oZXJpdHMoUGFja2VyQXN5bmMsIFN0cmVhbSk7XG5cblBhY2tlckFzeW5jLnByb3RvdHlwZS5wYWNrID0gZnVuY3Rpb24gKGRhdGEsIHdpZHRoLCBoZWlnaHQsIGdhbW1hKSB7XG4gIC8vIFNpZ25hdHVyZVxuICB0aGlzLmVtaXQoXCJkYXRhXCIsIEJ1ZmZlci5mcm9tKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFKSk7XG4gIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJSERSKHdpZHRoLCBoZWlnaHQpKTtcblxuICBpZiAoZ2FtbWEpIHtcbiAgICB0aGlzLmVtaXQoXCJkYXRhXCIsIHRoaXMuX3BhY2tlci5wYWNrR0FNQShnYW1tYSkpO1xuICB9XG5cbiAgbGV0IGZpbHRlcmVkRGF0YSA9IHRoaXMuX3BhY2tlci5maWx0ZXJEYXRhKGRhdGEsIHdpZHRoLCBoZWlnaHQpO1xuXG4gIC8vIGNvbXByZXNzIGl0XG4gIHRoaXMuX2RlZmxhdGUub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcblxuICB0aGlzLl9kZWZsYXRlLm9uKFxuICAgIFwiZGF0YVwiLFxuICAgIGZ1bmN0aW9uIChjb21wcmVzc2VkRGF0YSkge1xuICAgICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0lEQVQoY29tcHJlc3NlZERhdGEpKTtcbiAgICB9LmJpbmQodGhpcylcbiAgKTtcblxuICB0aGlzLl9kZWZsYXRlLm9uKFxuICAgIFwiZW5kXCIsXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0lFTkQoKSk7XG4gICAgICB0aGlzLmVtaXQoXCJlbmRcIik7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5lbmQoZmlsdGVyZWREYXRhKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBhc3NlcnQgPSByZXF1aXJlKFwiYXNzZXJ0XCIpLm9rO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5cbmxldCBrTWF4TGVuZ3RoID0gcmVxdWlyZShcImJ1ZmZlclwiKS5rTWF4TGVuZ3RoO1xuXG5mdW5jdGlvbiBJbmZsYXRlKG9wdHMpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIEluZmxhdGUpKSB7XG4gICAgcmV0dXJuIG5ldyBJbmZsYXRlKG9wdHMpO1xuICB9XG5cbiAgaWYgKG9wdHMgJiYgb3B0cy5jaHVua1NpemUgPCB6bGliLlpfTUlOX0NIVU5LKSB7XG4gICAgb3B0cy5jaHVua1NpemUgPSB6bGliLlpfTUlOX0NIVU5LO1xuICB9XG5cbiAgemxpYi5JbmZsYXRlLmNhbGwodGhpcywgb3B0cyk7XG5cbiAgLy8gTm9kZSA4IC0tPiA5IGNvbXBhdGliaWxpdHkgY2hlY2tcbiAgdGhpcy5fb2Zmc2V0ID0gdGhpcy5fb2Zmc2V0ID09PSB1bmRlZmluZWQgPyB0aGlzLl9vdXRPZmZzZXQgOiB0aGlzLl9vZmZzZXQ7XG4gIHRoaXMuX2J1ZmZlciA9IHRoaXMuX2J1ZmZlciB8fCB0aGlzLl9vdXRCdWZmZXI7XG5cbiAgaWYgKG9wdHMgJiYgb3B0cy5tYXhMZW5ndGggIT0gbnVsbCkge1xuICAgIHRoaXMuX21heExlbmd0aCA9IG9wdHMubWF4TGVuZ3RoO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUluZmxhdGUob3B0cykge1xuICByZXR1cm4gbmV3IEluZmxhdGUob3B0cyk7XG59XG5cbmZ1bmN0aW9uIF9jbG9zZShlbmdpbmUsIGNhbGxiYWNrKSB7XG4gIGlmIChjYWxsYmFjaykge1xuICAgIHByb2Nlc3MubmV4dFRpY2soY2FsbGJhY2spO1xuICB9XG5cbiAgLy8gQ2FsbGVyIG1heSBpbnZva2UgLmNsb3NlIGFmdGVyIGEgemxpYiBlcnJvciAod2hpY2ggd2lsbCBudWxsIF9oYW5kbGUpLlxuICBpZiAoIWVuZ2luZS5faGFuZGxlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZW5naW5lLl9oYW5kbGUuY2xvc2UoKTtcbiAgZW5naW5lLl9oYW5kbGUgPSBudWxsO1xufVxuXG5JbmZsYXRlLnByb3RvdHlwZS5fcHJvY2Vzc0NodW5rID0gZnVuY3Rpb24gKGNodW5rLCBmbHVzaEZsYWcsIGFzeW5jQ2IpIHtcbiAgaWYgKHR5cGVvZiBhc3luY0NiID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gemxpYi5JbmZsYXRlLl9wcm9jZXNzQ2h1bmsuY2FsbCh0aGlzLCBjaHVuaywgZmx1c2hGbGFnLCBhc3luY0NiKTtcbiAgfVxuXG4gIGxldCBzZWxmID0gdGhpcztcblxuICBsZXQgYXZhaWxJbkJlZm9yZSA9IGNodW5rICYmIGNodW5rLmxlbmd0aDtcbiAgbGV0IGF2YWlsT3V0QmVmb3JlID0gdGhpcy5fY2h1bmtTaXplIC0gdGhpcy5fb2Zmc2V0O1xuICBsZXQgbGVmdFRvSW5mbGF0ZSA9IHRoaXMuX21heExlbmd0aDtcbiAgbGV0IGluT2ZmID0gMDtcblxuICBsZXQgYnVmZmVycyA9IFtdO1xuICBsZXQgbnJlYWQgPSAwO1xuXG4gIGxldCBlcnJvcjtcbiAgdGhpcy5vbihcImVycm9yXCIsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICBlcnJvciA9IGVycjtcbiAgfSk7XG5cbiAgZnVuY3Rpb24gaGFuZGxlQ2h1bmsoYXZhaWxJbkFmdGVyLCBhdmFpbE91dEFmdGVyKSB7XG4gICAgaWYgKHNlbGYuX2hhZEVycm9yKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IGhhdmUgPSBhdmFpbE91dEJlZm9yZSAtIGF2YWlsT3V0QWZ0ZXI7XG4gICAgYXNzZXJ0KGhhdmUgPj0gMCwgXCJoYXZlIHNob3VsZCBub3QgZ28gZG93blwiKTtcblxuICAgIGlmIChoYXZlID4gMCkge1xuICAgICAgbGV0IG91dCA9IHNlbGYuX2J1ZmZlci5zbGljZShzZWxmLl9vZmZzZXQsIHNlbGYuX29mZnNldCArIGhhdmUpO1xuICAgICAgc2VsZi5fb2Zmc2V0ICs9IGhhdmU7XG5cbiAgICAgIGlmIChvdXQubGVuZ3RoID4gbGVmdFRvSW5mbGF0ZSkge1xuICAgICAgICBvdXQgPSBvdXQuc2xpY2UoMCwgbGVmdFRvSW5mbGF0ZSk7XG4gICAgICB9XG5cbiAgICAgIGJ1ZmZlcnMucHVzaChvdXQpO1xuICAgICAgbnJlYWQgKz0gb3V0Lmxlbmd0aDtcbiAgICAgIGxlZnRUb0luZmxhdGUgLT0gb3V0Lmxlbmd0aDtcblxuICAgICAgaWYgKGxlZnRUb0luZmxhdGUgPT09IDApIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChhdmFpbE91dEFmdGVyID09PSAwIHx8IHNlbGYuX29mZnNldCA+PSBzZWxmLl9jaHVua1NpemUpIHtcbiAgICAgIGF2YWlsT3V0QmVmb3JlID0gc2VsZi5fY2h1bmtTaXplO1xuICAgICAgc2VsZi5fb2Zmc2V0ID0gMDtcbiAgICAgIHNlbGYuX2J1ZmZlciA9IEJ1ZmZlci5hbGxvY1Vuc2FmZShzZWxmLl9jaHVua1NpemUpO1xuICAgIH1cblxuICAgIGlmIChhdmFpbE91dEFmdGVyID09PSAwKSB7XG4gICAgICBpbk9mZiArPSBhdmFpbEluQmVmb3JlIC0gYXZhaWxJbkFmdGVyO1xuICAgICAgYXZhaWxJbkJlZm9yZSA9IGF2YWlsSW5BZnRlcjtcblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgYXNzZXJ0KHRoaXMuX2hhbmRsZSwgXCJ6bGliIGJpbmRpbmcgY2xvc2VkXCIpO1xuICBsZXQgcmVzO1xuICBkbyB7XG4gICAgcmVzID0gdGhpcy5faGFuZGxlLndyaXRlU3luYyhcbiAgICAgIGZsdXNoRmxhZyxcbiAgICAgIGNodW5rLCAvLyBpblxuICAgICAgaW5PZmYsIC8vIGluX29mZlxuICAgICAgYXZhaWxJbkJlZm9yZSwgLy8gaW5fbGVuXG4gICAgICB0aGlzLl9idWZmZXIsIC8vIG91dFxuICAgICAgdGhpcy5fb2Zmc2V0LCAvL291dF9vZmZcbiAgICAgIGF2YWlsT3V0QmVmb3JlXG4gICAgKTsgLy8gb3V0X2xlblxuICAgIC8vIE5vZGUgOCAtLT4gOSBjb21wYXRpYmlsaXR5IGNoZWNrXG4gICAgcmVzID0gcmVzIHx8IHRoaXMuX3dyaXRlU3RhdGU7XG4gIH0gd2hpbGUgKCF0aGlzLl9oYWRFcnJvciAmJiBoYW5kbGVDaHVuayhyZXNbMF0sIHJlc1sxXSkpO1xuXG4gIGlmICh0aGlzLl9oYWRFcnJvcikge1xuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgaWYgKG5yZWFkID49IGtNYXhMZW5ndGgpIHtcbiAgICBfY2xvc2UodGhpcyk7XG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoXG4gICAgICBcIkNhbm5vdCBjcmVhdGUgZmluYWwgQnVmZmVyLiBJdCB3b3VsZCBiZSBsYXJnZXIgdGhhbiAweFwiICtcbiAgICAgICAga01heExlbmd0aC50b1N0cmluZygxNikgK1xuICAgICAgICBcIiBieXRlc1wiXG4gICAgKTtcbiAgfVxuXG4gIGxldCBidWYgPSBCdWZmZXIuY29uY2F0KGJ1ZmZlcnMsIG5yZWFkKTtcbiAgX2Nsb3NlKHRoaXMpO1xuXG4gIHJldHVybiBidWY7XG59O1xuXG51dGlsLmluaGVyaXRzKEluZmxhdGUsIHpsaWIuSW5mbGF0ZSk7XG5cbmZ1bmN0aW9uIHpsaWJCdWZmZXJTeW5jKGVuZ2luZSwgYnVmZmVyKSB7XG4gIGlmICh0eXBlb2YgYnVmZmVyID09PSBcInN0cmluZ1wiKSB7XG4gICAgYnVmZmVyID0gQnVmZmVyLmZyb20oYnVmZmVyKTtcbiAgfVxuICBpZiAoIShidWZmZXIgaW5zdGFuY2VvZiBCdWZmZXIpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIk5vdCBhIHN0cmluZyBvciBidWZmZXJcIik7XG4gIH1cblxuICBsZXQgZmx1c2hGbGFnID0gZW5naW5lLl9maW5pc2hGbHVzaEZsYWc7XG4gIGlmIChmbHVzaEZsYWcgPT0gbnVsbCkge1xuICAgIGZsdXNoRmxhZyA9IHpsaWIuWl9GSU5JU0g7XG4gIH1cblxuICByZXR1cm4gZW5naW5lLl9wcm9jZXNzQ2h1bmsoYnVmZmVyLCBmbHVzaEZsYWcpO1xufVxuXG5mdW5jdGlvbiBpbmZsYXRlU3luYyhidWZmZXIsIG9wdHMpIHtcbiAgcmV0dXJuIHpsaWJCdWZmZXJTeW5jKG5ldyBJbmZsYXRlKG9wdHMpLCBidWZmZXIpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHMgPSBpbmZsYXRlU3luYztcbmV4cG9ydHMuSW5mbGF0ZSA9IEluZmxhdGU7XG5leHBvcnRzLmNyZWF0ZUluZmxhdGUgPSBjcmVhdGVJbmZsYXRlO1xuZXhwb3J0cy5pbmZsYXRlU3luYyA9IGluZmxhdGVTeW5jO1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgU3luY1JlYWRlciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChidWZmZXIpIHtcbiAgdGhpcy5fYnVmZmVyID0gYnVmZmVyO1xuICB0aGlzLl9yZWFkcyA9IFtdO1xufSk7XG5cblN5bmNSZWFkZXIucHJvdG90eXBlLnJlYWQgPSBmdW5jdGlvbiAobGVuZ3RoLCBjYWxsYmFjaykge1xuICB0aGlzLl9yZWFkcy5wdXNoKHtcbiAgICBsZW5ndGg6IE1hdGguYWJzKGxlbmd0aCksIC8vIGlmIGxlbmd0aCA8IDAgdGhlbiBhdCBtb3N0IHRoaXMgbGVuZ3RoXG4gICAgYWxsb3dMZXNzOiBsZW5ndGggPCAwLFxuICAgIGZ1bmM6IGNhbGxiYWNrLFxuICB9KTtcbn07XG5cblN5bmNSZWFkZXIucHJvdG90eXBlLnByb2Nlc3MgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGFzIGxvbmcgYXMgdGhlcmUgaXMgYW55IGRhdGEgYW5kIHJlYWQgcmVxdWVzdHNcbiAgd2hpbGUgKHRoaXMuX3JlYWRzLmxlbmd0aCA+IDAgJiYgdGhpcy5fYnVmZmVyLmxlbmd0aCkge1xuICAgIGxldCByZWFkID0gdGhpcy5fcmVhZHNbMF07XG5cbiAgICBpZiAoXG4gICAgICB0aGlzLl9idWZmZXIubGVuZ3RoICYmXG4gICAgICAodGhpcy5fYnVmZmVyLmxlbmd0aCA+PSByZWFkLmxlbmd0aCB8fCByZWFkLmFsbG93TGVzcylcbiAgICApIHtcbiAgICAgIC8vIG9rIHRoZXJlIGlzIGFueSBkYXRhIHNvIHRoYXQgd2UgY2FuIHNhdGlzZnkgdGhpcyByZXF1ZXN0XG4gICAgICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgICAgIGxldCBidWYgPSB0aGlzLl9idWZmZXI7XG5cbiAgICAgIHRoaXMuX2J1ZmZlciA9IGJ1Zi5zbGljZShyZWFkLmxlbmd0aCk7XG5cbiAgICAgIHJlYWQuZnVuYy5jYWxsKHRoaXMsIGJ1Zi5zbGljZSgwLCByZWFkLmxlbmd0aCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlRoZXJlIGFyZSBzb21lIHJlYWQgcmVxdWVzdHMgd2FpdG5nIG9uIGZpbmlzaGVkIHN0cmVhbVwiKTtcbiAgfVxuXG4gIGlmICh0aGlzLl9idWZmZXIubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBjb250ZW50IGF0IGVuZCBvZiBzdHJlYW1cIik7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBTeW5jUmVhZGVyID0gcmVxdWlyZShcIi4vc3luYy1yZWFkZXJcIik7XG5sZXQgRmlsdGVyID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlXCIpO1xuXG5leHBvcnRzLnByb2Nlc3MgPSBmdW5jdGlvbiAoaW5CdWZmZXIsIGJpdG1hcEluZm8pIHtcbiAgbGV0IG91dEJ1ZmZlcnMgPSBbXTtcbiAgbGV0IHJlYWRlciA9IG5ldyBTeW5jUmVhZGVyKGluQnVmZmVyKTtcbiAgbGV0IGZpbHRlciA9IG5ldyBGaWx0ZXIoYml0bWFwSW5mbywge1xuICAgIHJlYWQ6IHJlYWRlci5yZWFkLmJpbmQocmVhZGVyKSxcbiAgICB3cml0ZTogZnVuY3Rpb24gKGJ1ZmZlclBhcnQpIHtcbiAgICAgIG91dEJ1ZmZlcnMucHVzaChidWZmZXJQYXJ0KTtcbiAgICB9LFxuICAgIGNvbXBsZXRlOiBmdW5jdGlvbiAoKSB7fSxcbiAgfSk7XG5cbiAgZmlsdGVyLnN0YXJ0KCk7XG4gIHJlYWRlci5wcm9jZXNzKCk7XG5cbiAgcmV0dXJuIEJ1ZmZlci5jb25jYXQob3V0QnVmZmVycyk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaGFzU3luY1psaWIgPSB0cnVlO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCBpbmZsYXRlU3luYyA9IHJlcXVpcmUoXCIuL3N5bmMtaW5mbGF0ZVwiKTtcbmlmICghemxpYi5kZWZsYXRlU3luYykge1xuICBoYXNTeW5jWmxpYiA9IGZhbHNlO1xufVxubGV0IFN5bmNSZWFkZXIgPSByZXF1aXJlKFwiLi9zeW5jLXJlYWRlclwiKTtcbmxldCBGaWx0ZXJTeW5jID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlLXN5bmNcIik7XG5sZXQgUGFyc2VyID0gcmVxdWlyZShcIi4vcGFyc2VyXCIpO1xubGV0IGJpdG1hcHBlciA9IHJlcXVpcmUoXCIuL2JpdG1hcHBlclwiKTtcbmxldCBmb3JtYXROb3JtYWxpc2VyID0gcmVxdWlyZShcIi4vZm9ybWF0LW5vcm1hbGlzZXJcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGJ1ZmZlciwgb3B0aW9ucykge1xuICBpZiAoIWhhc1N5bmNabGliKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJUbyB1c2UgdGhlIHN5bmMgY2FwYWJpbGl0eSBvZiB0aGlzIGxpYnJhcnkgaW4gb2xkIG5vZGUgdmVyc2lvbnMsIHBsZWFzZSBwaW4gcG5nanMgdG8gdjIuMy4wXCJcbiAgICApO1xuICB9XG5cbiAgbGV0IGVycjtcbiAgZnVuY3Rpb24gaGFuZGxlRXJyb3IoX2Vycl8pIHtcbiAgICBlcnIgPSBfZXJyXztcbiAgfVxuXG4gIGxldCBtZXRhRGF0YTtcbiAgZnVuY3Rpb24gaGFuZGxlTWV0YURhdGEoX21ldGFEYXRhXykge1xuICAgIG1ldGFEYXRhID0gX21ldGFEYXRhXztcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVRyYW5zQ29sb3IodHJhbnNDb2xvcikge1xuICAgIG1ldGFEYXRhLnRyYW5zQ29sb3IgPSB0cmFuc0NvbG9yO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGFsZXR0ZShwYWxldHRlKSB7XG4gICAgbWV0YURhdGEucGFsZXR0ZSA9IHBhbGV0dGU7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVTaW1wbGVUcmFuc3BhcmVuY3koKSB7XG4gICAgbWV0YURhdGEuYWxwaGEgPSB0cnVlO1xuICB9XG5cbiAgbGV0IGdhbW1hO1xuICBmdW5jdGlvbiBoYW5kbGVHYW1tYShfZ2FtbWFfKSB7XG4gICAgZ2FtbWEgPSBfZ2FtbWFfO1xuICB9XG5cbiAgbGV0IGluZmxhdGVEYXRhTGlzdCA9IFtdO1xuICBmdW5jdGlvbiBoYW5kbGVJbmZsYXRlRGF0YShpbmZsYXRlZERhdGEpIHtcbiAgICBpbmZsYXRlRGF0YUxpc3QucHVzaChpbmZsYXRlZERhdGEpO1xuICB9XG5cbiAgbGV0IHJlYWRlciA9IG5ldyBTeW5jUmVhZGVyKGJ1ZmZlcik7XG5cbiAgbGV0IHBhcnNlciA9IG5ldyBQYXJzZXIob3B0aW9ucywge1xuICAgIHJlYWQ6IHJlYWRlci5yZWFkLmJpbmQocmVhZGVyKSxcbiAgICBlcnJvcjogaGFuZGxlRXJyb3IsXG4gICAgbWV0YWRhdGE6IGhhbmRsZU1ldGFEYXRhLFxuICAgIGdhbW1hOiBoYW5kbGVHYW1tYSxcbiAgICBwYWxldHRlOiBoYW5kbGVQYWxldHRlLFxuICAgIHRyYW5zQ29sb3I6IGhhbmRsZVRyYW5zQ29sb3IsXG4gICAgaW5mbGF0ZURhdGE6IGhhbmRsZUluZmxhdGVEYXRhLFxuICAgIHNpbXBsZVRyYW5zcGFyZW5jeTogaGFuZGxlU2ltcGxlVHJhbnNwYXJlbmN5LFxuICB9KTtcblxuICBwYXJzZXIuc3RhcnQoKTtcbiAgcmVhZGVyLnByb2Nlc3MoKTtcblxuICBpZiAoZXJyKSB7XG4gICAgdGhyb3cgZXJyO1xuICB9XG5cbiAgLy9qb2luIHRvZ2V0aGVyIHRoZSBpbmZsYXRlIGRhdGFzXG4gIGxldCBpbmZsYXRlRGF0YSA9IEJ1ZmZlci5jb25jYXQoaW5mbGF0ZURhdGFMaXN0KTtcbiAgaW5mbGF0ZURhdGFMaXN0Lmxlbmd0aCA9IDA7XG5cbiAgbGV0IGluZmxhdGVkRGF0YTtcbiAgaWYgKG1ldGFEYXRhLmludGVybGFjZSkge1xuICAgIGluZmxhdGVkRGF0YSA9IHpsaWIuaW5mbGF0ZVN5bmMoaW5mbGF0ZURhdGEpO1xuICB9IGVsc2Uge1xuICAgIGxldCByb3dTaXplID1cbiAgICAgICgobWV0YURhdGEud2lkdGggKiBtZXRhRGF0YS5icHAgKiBtZXRhRGF0YS5kZXB0aCArIDcpID4+IDMpICsgMTtcbiAgICBsZXQgaW1hZ2VTaXplID0gcm93U2l6ZSAqIG1ldGFEYXRhLmhlaWdodDtcbiAgICBpbmZsYXRlZERhdGEgPSBpbmZsYXRlU3luYyhpbmZsYXRlRGF0YSwge1xuICAgICAgY2h1bmtTaXplOiBpbWFnZVNpemUsXG4gICAgICBtYXhMZW5ndGg6IGltYWdlU2l6ZSxcbiAgICB9KTtcbiAgfVxuICBpbmZsYXRlRGF0YSA9IG51bGw7XG5cbiAgaWYgKCFpbmZsYXRlZERhdGEgfHwgIWluZmxhdGVkRGF0YS5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiYWQgcG5nIC0gaW52YWxpZCBpbmZsYXRlIGRhdGEgcmVzcG9uc2VcIik7XG4gIH1cblxuICBsZXQgdW5maWx0ZXJlZERhdGEgPSBGaWx0ZXJTeW5jLnByb2Nlc3MoaW5mbGF0ZWREYXRhLCBtZXRhRGF0YSk7XG4gIGluZmxhdGVEYXRhID0gbnVsbDtcblxuICBsZXQgYml0bWFwRGF0YSA9IGJpdG1hcHBlci5kYXRhVG9CaXRNYXAodW5maWx0ZXJlZERhdGEsIG1ldGFEYXRhKTtcbiAgdW5maWx0ZXJlZERhdGEgPSBudWxsO1xuXG4gIGxldCBub3JtYWxpc2VkQml0bWFwRGF0YSA9IGZvcm1hdE5vcm1hbGlzZXIoXG4gICAgYml0bWFwRGF0YSxcbiAgICBtZXRhRGF0YSxcbiAgICBvcHRpb25zLnNraXBSZXNjYWxlXG4gICk7XG5cbiAgbWV0YURhdGEuZGF0YSA9IG5vcm1hbGlzZWRCaXRtYXBEYXRhO1xuICBtZXRhRGF0YS5nYW1tYSA9IGdhbW1hIHx8IDA7XG5cbiAgcmV0dXJuIG1ldGFEYXRhO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGhhc1N5bmNabGliID0gdHJ1ZTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5pZiAoIXpsaWIuZGVmbGF0ZVN5bmMpIHtcbiAgaGFzU3luY1psaWIgPSBmYWxzZTtcbn1cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChtZXRhRGF0YSwgb3B0KSB7XG4gIGlmICghaGFzU3luY1psaWIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIlRvIHVzZSB0aGUgc3luYyBjYXBhYmlsaXR5IG9mIHRoaXMgbGlicmFyeSBpbiBvbGQgbm9kZSB2ZXJzaW9ucywgcGxlYXNlIHBpbiBwbmdqcyB0byB2Mi4zLjBcIlxuICAgICk7XG4gIH1cblxuICBsZXQgb3B0aW9ucyA9IG9wdCB8fCB7fTtcblxuICBsZXQgcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcblxuICBsZXQgY2h1bmtzID0gW107XG5cbiAgLy8gU2lnbmF0dXJlXG4gIGNodW5rcy5wdXNoKEJ1ZmZlci5mcm9tKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFKSk7XG5cbiAgLy8gSGVhZGVyXG4gIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrSUhEUihtZXRhRGF0YS53aWR0aCwgbWV0YURhdGEuaGVpZ2h0KSk7XG5cbiAgaWYgKG1ldGFEYXRhLmdhbW1hKSB7XG4gICAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tHQU1BKG1ldGFEYXRhLmdhbW1hKSk7XG4gIH1cblxuICBsZXQgZmlsdGVyZWREYXRhID0gcGFja2VyLmZpbHRlckRhdGEoXG4gICAgbWV0YURhdGEuZGF0YSxcbiAgICBtZXRhRGF0YS53aWR0aCxcbiAgICBtZXRhRGF0YS5oZWlnaHRcbiAgKTtcblxuICAvLyBjb21wcmVzcyBpdFxuICBsZXQgY29tcHJlc3NlZERhdGEgPSB6bGliLmRlZmxhdGVTeW5jKFxuICAgIGZpbHRlcmVkRGF0YSxcbiAgICBwYWNrZXIuZ2V0RGVmbGF0ZU9wdGlvbnMoKVxuICApO1xuICBmaWx0ZXJlZERhdGEgPSBudWxsO1xuXG4gIGlmICghY29tcHJlc3NlZERhdGEgfHwgIWNvbXByZXNzZWREYXRhLmxlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJhZCBwbmcgLSBpbnZhbGlkIGNvbXByZXNzZWQgZGF0YSByZXNwb25zZVwiKTtcbiAgfVxuICBjaHVua3MucHVzaChwYWNrZXIucGFja0lEQVQoY29tcHJlc3NlZERhdGEpKTtcblxuICAvLyBFbmRcbiAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tJRU5EKCkpO1xuXG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcyk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgcGFyc2UgPSByZXF1aXJlKFwiLi9wYXJzZXItc3luY1wiKTtcbmxldCBwYWNrID0gcmVxdWlyZShcIi4vcGFja2VyLXN5bmNcIik7XG5cbmV4cG9ydHMucmVhZCA9IGZ1bmN0aW9uIChidWZmZXIsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIHBhcnNlKGJ1ZmZlciwgb3B0aW9ucyB8fCB7fSk7XG59O1xuXG5leHBvcnRzLndyaXRlID0gZnVuY3Rpb24gKHBuZywgb3B0aW9ucykge1xuICByZXR1cm4gcGFjayhwbmcsIG9wdGlvbnMpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlci1hc3luY1wiKTtcbmxldCBQYWNrZXIgPSByZXF1aXJlKFwiLi9wYWNrZXItYXN5bmNcIik7XG5sZXQgUE5HU3luYyA9IHJlcXVpcmUoXCIuL3BuZy1zeW5jXCIpO1xuXG5sZXQgUE5HID0gKGV4cG9ydHMuUE5HID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307IC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbm8tcGFyYW0tcmVhc3NpZ25cblxuICAvLyBjb2VyY2UgcGl4ZWwgZGltZW5zaW9ucyB0byBpbnRlZ2VycyAoYWxzbyBjb2VyY2VzIHVuZGVmaW5lZCAtPiAwKTpcbiAgdGhpcy53aWR0aCA9IG9wdGlvbnMud2lkdGggfCAwO1xuICB0aGlzLmhlaWdodCA9IG9wdGlvbnMuaGVpZ2h0IHwgMDtcblxuICB0aGlzLmRhdGEgPVxuICAgIHRoaXMud2lkdGggPiAwICYmIHRoaXMuaGVpZ2h0ID4gMFxuICAgICAgPyBCdWZmZXIuYWxsb2MoNCAqIHRoaXMud2lkdGggKiB0aGlzLmhlaWdodClcbiAgICAgIDogbnVsbDtcblxuICBpZiAob3B0aW9ucy5maWxsICYmIHRoaXMuZGF0YSkge1xuICAgIHRoaXMuZGF0YS5maWxsKDApO1xuICB9XG5cbiAgdGhpcy5nYW1tYSA9IDA7XG4gIHRoaXMucmVhZGFibGUgPSB0aGlzLndyaXRhYmxlID0gdHJ1ZTtcblxuICB0aGlzLl9wYXJzZXIgPSBuZXcgUGFyc2VyKG9wdGlvbnMpO1xuXG4gIHRoaXMuX3BhcnNlci5vbihcImVycm9yXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIikpO1xuICB0aGlzLl9wYXJzZXIub24oXCJjbG9zZVwiLCB0aGlzLl9oYW5kbGVDbG9zZS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFwibWV0YWRhdGFcIiwgdGhpcy5fbWV0YWRhdGEuYmluZCh0aGlzKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcImdhbW1hXCIsIHRoaXMuX2dhbW1hLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYXJzZXIub24oXG4gICAgXCJwYXJzZWRcIixcbiAgICBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgdGhpcy5kYXRhID0gZGF0YTtcbiAgICAgIHRoaXMuZW1pdChcInBhcnNlZFwiLCBkYXRhKTtcbiAgICB9LmJpbmQodGhpcylcbiAgKTtcblxuICB0aGlzLl9wYWNrZXIgPSBuZXcgUGFja2VyKG9wdGlvbnMpO1xuICB0aGlzLl9wYWNrZXIub24oXCJkYXRhXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZGF0YVwiKSk7XG4gIHRoaXMuX3BhY2tlci5vbihcImVuZFwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVuZFwiKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcImNsb3NlXCIsIHRoaXMuX2hhbmRsZUNsb3NlLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYWNrZXIub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbn0pO1xudXRpbC5pbmhlcml0cyhQTkcsIFN0cmVhbSk7XG5cblBORy5zeW5jID0gUE5HU3luYztcblxuUE5HLnByb3RvdHlwZS5wYWNrID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZGF0YSB8fCAhdGhpcy5kYXRhLmxlbmd0aCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIFwiTm8gZGF0YSBwcm92aWRlZFwiKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHByb2Nlc3MubmV4dFRpY2soXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5fcGFja2VyLnBhY2sodGhpcy5kYXRhLCB0aGlzLndpZHRoLCB0aGlzLmhlaWdodCwgdGhpcy5nYW1tYSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5QTkcucHJvdG90eXBlLnBhcnNlID0gZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gIGlmIChjYWxsYmFjaykge1xuICAgIGxldCBvblBhcnNlZCwgb25FcnJvcjtcblxuICAgIG9uUGFyc2VkID0gZnVuY3Rpb24gKHBhcnNlZERhdGEpIHtcbiAgICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBvbkVycm9yKTtcblxuICAgICAgdGhpcy5kYXRhID0gcGFyc2VkRGF0YTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHRoaXMpO1xuICAgIH0uYmluZCh0aGlzKTtcblxuICAgIG9uRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKFwicGFyc2VkXCIsIG9uUGFyc2VkKTtcblxuICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICB9LmJpbmQodGhpcyk7XG5cbiAgICB0aGlzLm9uY2UoXCJwYXJzZWRcIiwgb25QYXJzZWQpO1xuICAgIHRoaXMub25jZShcImVycm9yXCIsIG9uRXJyb3IpO1xuICB9XG5cbiAgdGhpcy5lbmQoZGF0YSk7XG4gIHJldHVybiB0aGlzO1xufTtcblxuUE5HLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX3BhcnNlci53cml0ZShkYXRhKTtcbiAgcmV0dXJuIHRydWU7XG59O1xuXG5QTkcucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX3BhcnNlci5lbmQoZGF0YSk7XG59O1xuXG5QTkcucHJvdG90eXBlLl9tZXRhZGF0YSA9IGZ1bmN0aW9uIChtZXRhZGF0YSkge1xuICB0aGlzLndpZHRoID0gbWV0YWRhdGEud2lkdGg7XG4gIHRoaXMuaGVpZ2h0ID0gbWV0YWRhdGEuaGVpZ2h0O1xuXG4gIHRoaXMuZW1pdChcIm1ldGFkYXRhXCIsIG1ldGFkYXRhKTtcbn07XG5cblBORy5wcm90b3R5cGUuX2dhbW1hID0gZnVuY3Rpb24gKGdhbW1hKSB7XG4gIHRoaXMuZ2FtbWEgPSBnYW1tYTtcbn07XG5cblBORy5wcm90b3R5cGUuX2hhbmRsZUNsb3NlID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuX3BhcnNlci53cml0YWJsZSAmJiAhdGhpcy5fcGFja2VyLnJlYWRhYmxlKSB7XG4gICAgdGhpcy5lbWl0KFwiY2xvc2VcIik7XG4gIH1cbn07XG5cblBORy5iaXRibHQgPSBmdW5jdGlvbiAoc3JjLCBkc3QsIHNyY1gsIHNyY1ksIHdpZHRoLCBoZWlnaHQsIGRlbHRhWCwgZGVsdGFZKSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICAvLyBjb2VyY2UgcGl4ZWwgZGltZW5zaW9ucyB0byBpbnRlZ2VycyAoYWxzbyBjb2VyY2VzIHVuZGVmaW5lZCAtPiAwKTpcbiAgLyogZXNsaW50LWRpc2FibGUgbm8tcGFyYW0tcmVhc3NpZ24gKi9cbiAgc3JjWCB8PSAwO1xuICBzcmNZIHw9IDA7XG4gIHdpZHRoIHw9IDA7XG4gIGhlaWdodCB8PSAwO1xuICBkZWx0YVggfD0gMDtcbiAgZGVsdGFZIHw9IDA7XG4gIC8qIGVzbGludC1lbmFibGUgbm8tcGFyYW0tcmVhc3NpZ24gKi9cblxuICBpZiAoXG4gICAgc3JjWCA+IHNyYy53aWR0aCB8fFxuICAgIHNyY1kgPiBzcmMuaGVpZ2h0IHx8XG4gICAgc3JjWCArIHdpZHRoID4gc3JjLndpZHRoIHx8XG4gICAgc3JjWSArIGhlaWdodCA+IHNyYy5oZWlnaHRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYml0Ymx0IHJlYWRpbmcgb3V0c2lkZSBpbWFnZVwiKTtcbiAgfVxuXG4gIGlmIChcbiAgICBkZWx0YVggPiBkc3Qud2lkdGggfHxcbiAgICBkZWx0YVkgPiBkc3QuaGVpZ2h0IHx8XG4gICAgZGVsdGFYICsgd2lkdGggPiBkc3Qud2lkdGggfHxcbiAgICBkZWx0YVkgKyBoZWlnaHQgPiBkc3QuaGVpZ2h0XG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJpdGJsdCB3cml0aW5nIG91dHNpZGUgaW1hZ2VcIik7XG4gIH1cblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgc3JjLmRhdGEuY29weShcbiAgICAgIGRzdC5kYXRhLFxuICAgICAgKChkZWx0YVkgKyB5KSAqIGRzdC53aWR0aCArIGRlbHRhWCkgPDwgMixcbiAgICAgICgoc3JjWSArIHkpICogc3JjLndpZHRoICsgc3JjWCkgPDwgMixcbiAgICAgICgoc3JjWSArIHkpICogc3JjLndpZHRoICsgc3JjWCArIHdpZHRoKSA8PCAyXG4gICAgKTtcbiAgfVxufTtcblxuUE5HLnByb3RvdHlwZS5iaXRibHQgPSBmdW5jdGlvbiAoXG4gIGRzdCxcbiAgc3JjWCxcbiAgc3JjWSxcbiAgd2lkdGgsXG4gIGhlaWdodCxcbiAgZGVsdGFYLFxuICBkZWx0YVlcbikge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcblxuICBQTkcuYml0Ymx0KHRoaXMsIGRzdCwgc3JjWCwgc3JjWSwgd2lkdGgsIGhlaWdodCwgZGVsdGFYLCBkZWx0YVkpO1xuICByZXR1cm4gdGhpcztcbn07XG5cblBORy5hZGp1c3RHYW1tYSA9IGZ1bmN0aW9uIChzcmMpIHtcbiAgaWYgKHNyYy5nYW1tYSkge1xuICAgIGZvciAobGV0IHkgPSAwOyB5IDwgc3JjLmhlaWdodDsgeSsrKSB7XG4gICAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHNyYy53aWR0aDsgeCsrKSB7XG4gICAgICAgIGxldCBpZHggPSAoc3JjLndpZHRoICogeSArIHgpIDw8IDI7XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcbiAgICAgICAgICBsZXQgc2FtcGxlID0gc3JjLmRhdGFbaWR4ICsgaV0gLyAyNTU7XG4gICAgICAgICAgc2FtcGxlID0gTWF0aC5wb3coc2FtcGxlLCAxIC8gMi4yIC8gc3JjLmdhbW1hKTtcbiAgICAgICAgICBzcmMuZGF0YVtpZHggKyBpXSA9IE1hdGgucm91bmQoc2FtcGxlICogMjU1KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBzcmMuZ2FtbWEgPSAwO1xuICB9XG59O1xuXG5QTkcucHJvdG90eXBlLmFkanVzdEdhbW1hID0gZnVuY3Rpb24gKCkge1xuICBQTkcuYWRqdXN0R2FtbWEodGhpcyk7XG59O1xuIiwgImltcG9ydCB7IFBORyB9IGZyb20gJ3BuZ2pzJztcbmltcG9ydCB0eXBlIHsgRmlnbWFDb2xvciwgRmlnbWFOb2RlLCBSZWN0IH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIE1hc2tUaW50Q2FuZGlkYXRlIHtcbiAgICBtYXNrOiBGaWdtYU5vZGU7XG4gICAgdGludDogRmlnbWFDb2xvcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNYXNrVGludEFuYWx5c2lzIHtcbiAgICBjYW5kaWRhdGU/OiBNYXNrVGludENhbmRpZGF0ZTtcbiAgICByZWFzb246IHN0cmluZztcbn1cblxuY29uc3QgRVBTSUxPTiA9IDAuMDAwMTtcbmNvbnN0IG5vcm1hbEJsZW5kID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4gIW5vZGUuYmxlbmRNb2RlXG4gICAgfHwgWydOT1JNQUwnLCAnUEFTU19USFJPVUdIJ10uaW5jbHVkZXMobm9kZS5ibGVuZE1vZGUpO1xuY29uc3Qgbm9FZmZlY3RzID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4gIW5vZGUuZWZmZWN0cy5zb21lKChlZmZlY3QpID0+IGVmZmVjdC52aXNpYmxlICE9PSBmYWxzZSlcbiAgICAmJiAhKG5vZGUuc3Ryb2tlV2VpZ2h0ID4gMCAmJiBub2RlLnN0cm9rZXMuc29tZSgocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlKSk7XG5jb25zdCBwYWludHMgPSAobm9kZTogRmlnbWFOb2RlKSA9PiBub2RlLmZpbGxzLmZpbHRlcigocGFpbnQpID0+IHBhaW50LnZpc2libGUgIT09IGZhbHNlICYmIChwYWludC5vcGFjaXR5ID8/IDEpID4gMCk7XG5jb25zdCBuZXV0cmFsVHJhbnNmb3JtID0gKG5vZGU6IEZpZ21hTm9kZSkgPT4gTWF0aC5hYnMobm9kZS5yb3RhdGlvbikgPD0gRVBTSUxPTlxuICAgICYmICghbm9kZS5yZWxhdGl2ZVRyYW5zZm9ybSB8fCAobm9kZS5yZWxhdGl2ZVRyYW5zZm9ybS5sZW5ndGggPT09IDJcbiAgICAgICAgJiYgTWF0aC5hYnMobm9kZS5yZWxhdGl2ZVRyYW5zZm9ybVswXT8uWzBdIC0gMSkgPD0gRVBTSUxPTlxuICAgICAgICAmJiBNYXRoLmFicyhub2RlLnJlbGF0aXZlVHJhbnNmb3JtWzBdPy5bMV0pIDw9IEVQU0lMT05cbiAgICAgICAgJiYgTWF0aC5hYnMobm9kZS5yZWxhdGl2ZVRyYW5zZm9ybVsxXT8uWzBdKSA8PSBFUFNJTE9OXG4gICAgICAgICYmIE1hdGguYWJzKG5vZGUucmVsYXRpdmVUcmFuc2Zvcm1bMV0/LlsxXSAtIDEpIDw9IEVQU0lMT04pKTtcbmNvbnN0IHNhbWVGcmFtZSA9IChhPzogUmVjdCwgYj86IFJlY3QpID0+IEJvb2xlYW4oYSAmJiBiICYmIFsneCcsICd5JywgJ3dpZHRoJywgJ2hlaWdodCddXG4gICAgLmV2ZXJ5KChrZXkpID0+IE1hdGguYWJzKGFba2V5IGFzIGtleW9mIFJlY3RdIC0gYltrZXkgYXMga2V5b2YgUmVjdF0pIDw9IEVQU0lMT04pKTtcblxuLyoqIFJlc3RyaWN0IHRoZSBvcHRpbWl6YXRpb24gdG8gYW4gYWN0dWFsIEFMUEhBIG1hc2sgZm9sbG93ZWQgYnkgb25lIHNvbGlkIGNvdmVyLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFuYWx5emVNYXNrVGludChub2RlOiBGaWdtYU5vZGUpOiBNYXNrVGludEFuYWx5c2lzIHwgdW5kZWZpbmVkIHtcbiAgICBpZiAoIW5vZGUuY2hpbGRyZW4uc29tZSgoY2hpbGQpID0+IGNoaWxkLmlzTWFzaykpIHJldHVybiB1bmRlZmluZWQ7XG4gICAgY29uc3QgZmFpbCA9IChyZWFzb246IHN0cmluZyk6IE1hc2tUaW50QW5hbHlzaXMgPT4gKHsgcmVhc29uIH0pO1xuICAgIGlmICghbm9ybWFsQmxlbmQobm9kZSkgfHwgIW5vRWZmZWN0cyhub2RlKSB8fCBwYWludHMobm9kZSkubGVuZ3RoIHx8ICFuZXV0cmFsVHJhbnNmb3JtKG5vZGUpXG4gICAgICAgIHx8IChub2RlLmxheW91dE1vZGUgJiYgbm9kZS5sYXlvdXRNb2RlICE9PSAnTk9ORScpIHx8IG5vZGUub3ZlcmZsb3dEaXJlY3Rpb25cbiAgICAgICAgfHwgbm9kZS5jbGlwc0NvbnRlbnQpIHJldHVybiBmYWlsKCdcdTg0OTlcdTcyNDhcdTVCQjlcdTU2NjhcdTVFMjZcdTY3MDlcdTk4OURcdTU5MTZcdTdFRDhcdTUyMzZcdTMwMDFcdTUzRDhcdTYzNjJcdTMwMDFcdTg4QzFcdTUyMDdcdTYyMTZcdThGRDBcdTg4NENcdTY1RjZcdTVFMDNcdTVDNDAnKTtcbiAgICBpZiAobm9kZS5jaGlsZHJlbi5sZW5ndGggIT09IDIpIHJldHVybiBmYWlsKCdcdTRFQzVcdTY1MkZcdTYzMDFcdTRFMDBcdTRFMkFcdTc3MUZcdTVCOUUgQWxwaGEgXHU4NDk5XHU3MjQ4XHU0RTBFXHU0RTAwXHU0RTJBXHU3RUFGXHU4MjcyXHU4OTg2XHU3NkQ2XHU1QzQyJyk7XG4gICAgY29uc3QgW21hc2ssIGNvdmVyXSA9IG5vZGUuY2hpbGRyZW47XG4gICAgaWYgKCFtYXNrLmlzTWFzayB8fCBtYXNrLm1hc2tUeXBlICE9PSAnQUxQSEEnIHx8IGNvdmVyLmlzTWFzaykgcmV0dXJuIGZhaWwoJ1x1ODQ5OVx1NzI0OFx1N0M3Qlx1NTc4Qlx1NjcyQVx1NjYwRVx1Nzg2RVx1NEUzQSBBTFBIQVx1RkYwQ1x1NjIxNlx1ODQ5OVx1NzI0OFx1OTg3QVx1NUU4Ri9cdTY1NzBcdTkxQ0ZcdTRFMERcdTUzRDdcdTY1MkZcdTYzMDEnKTtcbiAgICBpZiAoIW1hc2sudmlzaWJsZSB8fCAhY292ZXIudmlzaWJsZSB8fCBtYXNrLm9wYWNpdHkgIT09IDEpIHJldHVybiBmYWlsKCdcdTg0OTlcdTcyNDgvXHU4OTg2XHU3NkQ2XHU1QzQyXHU5NjkwXHU4NUNGXHU2MjE2XHU4NDk5XHU3MjQ4XHU5MDBGXHU2NjBFXHU1RUE2XHU0RTBEXHU0RTNBIDEwMCUnKTtcbiAgICBpZiAoIW5vcm1hbEJsZW5kKG1hc2spIHx8ICFub3JtYWxCbGVuZChjb3ZlcikgfHwgIW5vRWZmZWN0cyhtYXNrKSB8fCAhbm9FZmZlY3RzKGNvdmVyKVxuICAgICAgICB8fCAhbmV1dHJhbFRyYW5zZm9ybShtYXNrKSB8fCAhbmV1dHJhbFRyYW5zZm9ybShjb3ZlcilcbiAgICAgICAgfHwgIXNhbWVGcmFtZShub2RlLmFic29sdXRlQm91bmRpbmdCb3gsIG1hc2suYWJzb2x1dGVCb3VuZGluZ0JveClcbiAgICAgICAgfHwgIXNhbWVGcmFtZShub2RlLmFic29sdXRlQm91bmRpbmdCb3gsIGNvdmVyLmFic29sdXRlQm91bmRpbmdCb3gpKSByZXR1cm4gZmFpbCgnXHU4NDk5XHU3MjQ4XHU0RTBFXHU4OTg2XHU3NkQ2XHU1QzQyXHU3Njg0XHU1MUUwXHU0RjU1XHUzMDAxXHU2REY3XHU1NDA4XHU2MjE2XHU2NTQ4XHU2NzlDXHU0RTBEXHU4MEZEXHU3QjQ5XHU0RUY3XHU2NjIwXHU1QzA0Jyk7XG4gICAgaWYgKGNvdmVyLnR5cGUgIT09ICdSRUNUQU5HTEUnIHx8IGNvdmVyLmNoaWxkcmVuLmxlbmd0aFxuICAgICAgICB8fCBbY292ZXIuY29ybmVyUmFkaXVzID8/IDAsIC4uLihjb3Zlci5yZWN0YW5nbGVDb3JuZXJSYWRpaSA/PyBbXSldLnNvbWUoKHJhZGl1cykgPT4gcmFkaXVzID4gMCkpIHtcbiAgICAgICAgcmV0dXJuIGZhaWwoJ1x1N0VBRlx1ODI3Mlx1ODk4Nlx1NzZENlx1NUM0Mlx1NEUwRFx1NjYyRlx1NUI4Q1x1NjU3NFx1NjVFMFx1NTcwNlx1ODlEMlx1NzdFOVx1NUY2MicpO1xuICAgIH1cbiAgICBjb25zdCBmaWxscyA9IHBhaW50cyhjb3Zlcik7XG4gICAgY29uc3QgZmlsbCA9IGZpbGxzWzBdO1xuICAgIGlmIChmaWxscy5sZW5ndGggIT09IDEgfHwgZmlsbC50eXBlICE9PSAnU09MSUQnIHx8ICFmaWxsLmNvbG9yXG4gICAgICAgIHx8IChmaWxsLmJsZW5kTW9kZSAmJiBmaWxsLmJsZW5kTW9kZSAhPT0gJ05PUk1BTCcpKSByZXR1cm4gZmFpbCgnXHU4OTg2XHU3NkQ2XHU1QzQyXHU0RTBEXHU2NjJGXHU1MzU1XHU0RTAwXHU2NjZFXHU5MDFBXHU2REY3XHU1NDA4XHU3Njg0XHU3RUFGXHU4MjcyXHU1ODZCXHU1MTQ1Jyk7XG4gICAgLy8gTmVzdGVkIG1hc2tzL2VmZmVjdHMvcGFydGlhbCBub2RlIG9wYWNpdHkgY2Fubm90IGJlIGVzdGFibGlzaGVkIGZyb20gYVxuICAgIC8vIHNhbWUtbmFtZSBsb2NhbCBiaXRtYXAuIFRoZXkgbXVzdCB1c2UgRmlnbWEncyBjb21wbGV0ZSBjb21wb3NpdGlvbi5cbiAgICBjb25zdCBzYWZlTWFzayA9IChwYXJ0OiBGaWdtYU5vZGUsIHJvb3QgPSBmYWxzZSk6IGJvb2xlYW4gPT4gbm9ybWFsQmxlbmQocGFydClcbiAgICAgICAgJiYgbm9FZmZlY3RzKHBhcnQpICYmIG5ldXRyYWxUcmFuc2Zvcm0ocGFydCkgJiYgcGFydC52aXNpYmxlICYmIHBhcnQub3BhY2l0eSA9PT0gMVxuICAgICAgICAmJiAocm9vdCB8fCAhcGFydC5pc01hc2spICYmICFwYXJ0LmNsaXBzQ29udGVudFxuICAgICAgICAmJiBwYWludHMocGFydCkuZXZlcnkoKHBhaW50KSA9PiAoIXBhaW50LmJsZW5kTW9kZSB8fCBwYWludC5ibGVuZE1vZGUgPT09ICdOT1JNQUwnKVxuICAgICAgICAgICAgJiYgKHBhaW50Lm9wYWNpdHkgPz8gMSkgPT09IDFcbiAgICAgICAgICAgICYmICgocGFpbnQudHlwZSA9PT0gJ0lNQUdFJyAmJiBwYWludC5pbWFnZVRyYW5zZm9ybSA9PT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgJiYgKCFwYWludC5maWx0ZXJzIHx8IE9iamVjdC52YWx1ZXMocGFpbnQuZmlsdGVycykuZXZlcnkoKHZhbHVlKSA9PiB2YWx1ZSA9PT0gMCkpXG4gICAgICAgICAgICAgICAgJiYgWydGSUxMJywgJ0ZJVCddLmluY2x1ZGVzKHBhaW50LnNjYWxlTW9kZT8udG9VcHBlckNhc2UoKSA/PyAnRklMTCcpXG4gICAgICAgICAgICAgICAgJiYgTWF0aC5hYnMocGFpbnQucm90YXRpb24gPz8gMCkgPD0gRVBTSUxPTikgfHwgKHBhaW50LnR5cGUgPT09ICdTT0xJRCcgJiYgcGFpbnQuY29sb3JcbiAgICAgICAgICAgICAgICAmJiBwYWludC5jb2xvci5yID09PSAxICYmIHBhaW50LmNvbG9yLmcgPT09IDEgJiYgcGFpbnQuY29sb3IuYiA9PT0gMSAmJiAocGFpbnQuY29sb3IuYSA/PyAxKSA9PT0gMSkpKVxuICAgICAgICAmJiBwYXJ0LmNoaWxkcmVuLmV2ZXJ5KChjaGlsZCkgPT4gc2FmZU1hc2soY2hpbGQpKTtcbiAgICBpZiAoIXNhZmVNYXNrKG1hc2ssIHRydWUpKSByZXR1cm4gZmFpbCgnXHU4NDk5XHU3MjQ4XHU1MTg1XHU5MEU4XHU1NDJCXHU2NzA5XHU2NzJBXHU4MEZEXHU4QkMxXHU2NjBFXHU3QjQ5XHU0RUY3XHU3Njg0XHU5ODlDXHU4MjcyXHUzMDAxXHU5MDBGXHU2NjBFXHU1RUE2XHUzMDAxXHU2NTQ4XHU2NzlDXHU2MjE2XHU1RDRDXHU1OTU3XHU4NDk5XHU3MjQ4Jyk7XG4gICAgcmV0dXJuIHsgY2FuZGlkYXRlOiB7IG1hc2ssIHRpbnQ6IHsgLi4uZmlsbC5jb2xvcixcbiAgICAgICAgYTogKGZpbGwuY29sb3IuYSA/PyAxKSAqIChmaWxsLm9wYWNpdHkgPz8gMSkgKiBjb3Zlci5vcGFjaXR5IH0gfSxcbiAgICByZWFzb246ICdcdTc3MUZcdTVCOUUgQWxwaGEgXHU4NDk5XHU3MjQ4XHU0RTBFXHU1MzU1XHU4MjcyXHU4OTg2XHU3NkQ2XHU1QzQyXHU1M0VGXHU0RjdGXHU3NTI4XHU3RUNGXHU5QThDXHU4QkMxXHU3Njg0XHU3NjdEXHU4MjcyXHU1RTk1XHU1NkZFXHU1NDhDXHU1QjlFXHU0RjhCIFNwcml0ZSBDb2xvcicgfTtcbn1cblxuLyoqIFdoaXRlIFJHQiBhdCBldmVyeSBjb250cmlidXRpbmcgcGl4ZWwgaXMgcmVxdWlyZWQgZm9yIGV4YWN0IG11bHRpcGx5IHRpbnQuICovXG5leHBvcnQgZnVuY3Rpb24gdmVyaWZ5V2hpdGVBbHBoYVBuZyhjb250ZW50czogQnVmZmVyKTogeyB2YWxpZDogYm9vbGVhbjsgcmVhc29uOiBzdHJpbmcgfSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKGNvbnRlbnRzLmxlbmd0aCA8IDMzIHx8ICFjb250ZW50cy5zdWJhcnJheSgwLCA4KS5lcXVhbHMoQnVmZmVyLmZyb20oWzEzNywgODAsIDc4LCA3MSwgMTMsIDEwLCAyNiwgMTBdKSkpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHZhbGlkOiBmYWxzZSwgcmVhc29uOiAnXHU1RTk1XHU1NkZFXHU0RTBEXHU2NjJGXHU1M0VGXHU5QThDXHU4QkMxXHU3Njg0IFBOR1x1RkYwQ1x1NEZERFx1NUI4OFx1NEY3Rlx1NzUyOFx1NUI4Q1x1NjU3NFx1NTQwOFx1NjIxMCcgfTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCB3aWR0aCA9IGNvbnRlbnRzLnJlYWRVSW50MzJCRSgxNiksIGhlaWdodCA9IGNvbnRlbnRzLnJlYWRVSW50MzJCRSgyMCk7XG4gICAgICAgIGlmICghd2lkdGggfHwgIWhlaWdodCB8fCB3aWR0aCAqIGhlaWdodCA+IDE2XzAwMF8wMDApIHRocm93IG5ldyBFcnJvcignXHU1RTk1XHU1NkZFXHU1QzNBXHU1QkY4XHU4RDg1XHU4RkM3XHU1Qjg5XHU1MTY4XHU4OUUzXHU3ODAxXHU4MzAzXHU1NkY0Jyk7XG4gICAgICAgIGNvbnN0IGltYWdlID0gUE5HLnN5bmMucmVhZChjb250ZW50cywgeyBjaGVja0NSQzogdHJ1ZSwgc2tpcFJlc2NhbGU6IHRydWUgfSk7XG4gICAgICAgIGNvbnN0IG1heGltdW0gPSBOdW1iZXIoaW1hZ2UuY29sb3JUeXBlKSA9PT0gMyA/IDI1NSA6IDIgKiogaW1hZ2UuZGVwdGggLSAxO1xuICAgICAgICBsZXQgY29udHJpYnV0aW5nID0gZmFsc2U7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgaW1hZ2UuZGF0YS5sZW5ndGg7IGkgKz0gNCkge1xuICAgICAgICAgICAgaWYgKGltYWdlLmRhdGFbaSArIDNdID09PSAwKSBjb250aW51ZTtcbiAgICAgICAgICAgIGNvbnRyaWJ1dGluZyA9IHRydWU7XG4gICAgICAgICAgICBpZiAoaW1hZ2UuZGF0YVtpXSAhPT0gbWF4aW11bSB8fCBpbWFnZS5kYXRhW2kgKyAxXSAhPT0gbWF4aW11bSB8fCBpbWFnZS5kYXRhW2kgKyAyXSAhPT0gbWF4aW11bSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7IHZhbGlkOiBmYWxzZSwgcmVhc29uOiAnXHU1RTk1XHU1NkZFXHU1NDJCXHU5NzVFXHU3NjdEIFJHQlx1RkYwQ1Nwcml0ZSBcdTRFNThcdTgyNzJcdTRGMUFcdTUwNEZcdTY2OTdcdUZGMENcdTRGRERcdTVCODhcdTRGN0ZcdTc1MjhcdTVCOENcdTY1NzRcdTU0MDhcdTYyMTAnIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHsgdmFsaWQ6IGNvbnRyaWJ1dGluZywgcmVhc29uOiBjb250cmlidXRpbmcgPyAnXHU1REYyXHU5MDEwXHU1MENGXHU3RDIwXHU3ODZFXHU4QkE0XHU3NjdEXHU4MjcyIFJHQiBcdTRFMEVcdTkwMEZcdTY2MEVcdThGNkVcdTVFRDMnIDogJ1x1NUU5NVx1NTZGRVx1NUI4Q1x1NTE2OFx1OTAwRlx1NjYwRVx1RkYwQ1x1NjVFMFx1NkNENVx1OEJDMVx1NjYwRVx1NjcwOVx1NjU0OFx1OEY2RVx1NUVEMycgfTtcbiAgICB9IGNhdGNoIChlcnJvcikgeyByZXR1cm4geyB2YWxpZDogZmFsc2UsIHJlYXNvbjogYFx1NUU5NVx1NTZGRVx1NjVFMFx1NkNENVx1NUI4OVx1NTE2OFx1ODlFM1x1NzgwMVx1RkYxQSR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWAgfTsgfVxufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQSwwQ0FBQUEsVUFBQUMsU0FBQTtBQUFBO0FBRUEsUUFBSSxPQUFPLFFBQVEsTUFBTTtBQUN6QixRQUFJLFNBQVMsUUFBUSxRQUFRO0FBRTdCLFFBQUksY0FBZUEsUUFBTyxVQUFVLFdBQVk7QUFDOUMsYUFBTyxLQUFLLElBQUk7QUFFaEIsV0FBSyxXQUFXLENBQUM7QUFDakIsV0FBSyxZQUFZO0FBRWpCLFdBQUssU0FBUyxDQUFDO0FBQ2YsV0FBSyxVQUFVO0FBRWYsV0FBSyxZQUFZO0FBQ2pCLFdBQUssV0FBVztBQUFBLElBQ2xCO0FBQ0EsU0FBSyxTQUFTLGFBQWEsTUFBTTtBQUVqQyxnQkFBWSxVQUFVLE9BQU8sU0FBVSxRQUFRLFVBQVU7QUFDdkQsV0FBSyxPQUFPLEtBQUs7QUFBQSxRQUNmLFFBQVEsS0FBSyxJQUFJLE1BQU07QUFBQTtBQUFBLFFBQ3ZCLFdBQVcsU0FBUztBQUFBLFFBQ3BCLE1BQU07QUFBQSxNQUNSLENBQUM7QUFFRCxjQUFRO0FBQUEsUUFDTixXQUFZO0FBQ1YsZUFBSyxTQUFTO0FBR2QsY0FBSSxLQUFLLFdBQVcsS0FBSyxVQUFVLEtBQUssT0FBTyxTQUFTLEdBQUc7QUFDekQsaUJBQUssVUFBVTtBQUVmLGlCQUFLLEtBQUssT0FBTztBQUFBLFVB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QyxHQUFHO0FBQ3pHLGFBQU8sRUFBRSxPQUFPLE9BQU8sUUFBUSw2R0FBd0I7QUFBQSxJQUMzRDtBQUNBLFVBQU0sUUFBUSxTQUFTLGFBQWEsRUFBRSxHQUFHLFNBQVMsU0FBUyxhQUFhLEVBQUU7QUFDMUUsUUFBSSxDQUFDLFNBQVMsQ0FBQyxVQUFVLFFBQVEsU0FBUyxLQUFZLE9BQU0sSUFBSSxNQUFNLDBFQUFjO0FBQ3BGLFVBQU0sUUFBUSxpQkFBSSxLQUFLLEtBQUssVUFBVSxFQUFFLFVBQVUsTUFBTSxhQUFhLEtBQUssQ0FBQztBQUMzRSxVQUFNLFVBQVUsT0FBTyxNQUFNLFNBQVMsTUFBTSxJQUFJLE1BQU0sS0FBSyxNQUFNLFFBQVE7QUFDekUsUUFBSSxlQUFlO0FBQ25CLGFBQVMsSUFBSSxHQUFHLElBQUksTUFBTSxLQUFLLFFBQVEsS0FBSyxHQUFHO0FBQzNDLFVBQUksTUFBTSxLQUFLLElBQUksQ0FBQyxNQUFNLEVBQUc7QUFDN0IscUJBQWU7QUFDZixVQUFJLE1BQU0sS0FBSyxDQUFDLE1BQU0sV0FBVyxNQUFNLEtBQUssSUFBSSxDQUFDLE1BQU0sV0FBVyxNQUFNLEtBQUssSUFBSSxDQUFDLE1BQU0sU0FBUztBQUM3RixlQUFPLEVBQUUsT0FBTyxPQUFPLFFBQVEsc0lBQWtDO0FBQUEsTUFDckU7QUFBQSxJQUNKO0FBQ0EsV0FBTyxFQUFFLE9BQU8sY0FBYyxRQUFRLGVBQWUsd0ZBQXVCLDZGQUFrQjtBQUFBLEVBQ2xHLFNBQVMsT0FBTztBQUFFLFdBQU8sRUFBRSxPQUFPLE9BQU8sUUFBUSx5REFBYSxNQUFnQixPQUFPLEdBQUc7QUFBQSxFQUFHO0FBQy9GOyIsCiAgIm5hbWVzIjogWyJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJpbmZsYXRlZERhdGEiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIlBORyJdCn0K
