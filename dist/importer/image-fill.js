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

// source/importer/image-fill.ts
var image_fill_exports = {};
__export(image_fill_exports, {
  rasterizeImageFill: () => rasterizeImageFill
});
module.exports = __toCommonJS(image_fill_exports);
var import_pngjs = __toESM(require_png());
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var MAX_PIXELS = 16 * 1024 * 1024;
var MAX_BYTES = 64 * 1024 * 1024;
var COLOR_CHUNKS = /* @__PURE__ */ new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new Error("IMAGE \u586B\u5145\u5C3A\u5BF8\u8D85\u8FC7\u5B89\u5168\u5904\u7406\u8303\u56F4\uFF08\u5355\u8FB9 8192\uFF0C\u5408\u8BA1 1600 \u4E07\u50CF\u7D20\uFF09\u3002");
  }
}
function inspect(contents) {
  if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE) || contents.readUInt32BE(8) !== 13 || contents.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("IMAGE \u6E90\u56FE\u7247\u4E0D\u662F\u6709\u6548\u7684 PNG\u3002");
  }
  const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
  dimensions(width, height);
  if (contents[24] > 8) throw new Error("\u6682\u4E0D\u652F\u6301\u91CD\u91C7\u6837\u9AD8\u4F4D\u6DF1 IMAGE \u586B\u5145\u3002");
  const metadata = [];
  for (let offset = 8; offset + 12 <= contents.length; ) {
    const end = offset + 12 + contents.readUInt32BE(offset);
    if (end > contents.length) break;
    const type = contents.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "fcTL", "fdAT", "sBIT"].includes(type)) {
      throw new Error("\u6682\u4E0D\u652F\u6301\u91CD\u91C7\u6837\u52A8\u753B\u6216\u7279\u6B8A\u4F4D\u6DF1 IMAGE \u586B\u5145\u3002");
    }
    if (COLOR_CHUNKS.has(type)) metadata.push(contents.subarray(offset, end));
    if (type === "IEND") {
      if (end !== contents.length) throw new Error("IMAGE PNG \u5305\u542B\u65E0\u6CD5\u89E3\u91CA\u7684\u989D\u5916\u6570\u636E\u3002");
      return { width, height, metadata };
    }
    offset = end;
  }
  throw new Error("IMAGE PNG \u6570\u636E\u4E0D\u5B8C\u6574\u3002");
}
function decodeToPng(contents) {
  try {
    const { nativeImage } = require("electron");
    const image = nativeImage.createFromBuffer(contents);
    if (image.isEmpty()) throw new Error("\u65E0\u6CD5\u8BC6\u522B\u56FE\u7247\u683C\u5F0F");
    const { width, height } = image.getSize();
    dimensions(width, height);
    return image.toPNG();
  } catch (error) {
    throw new Error(`\u65E0\u6CD5\u89E3\u7801 IMAGE \u6E90\u56FE\u7247\uFF1A${error.message}`);
  }
}
function samples(source, target, ratio, offset) {
  return Array.from({ length: target }, (_, out) => {
    if (ratio <= 1) {
      const start = (out - offset) / ratio, end = (out + 1 - offset) / ratio;
      const result = [];
      const first2 = Math.max(0, Math.floor(start));
      const last = Math.min(source, Math.ceil(end));
      for (let index = first2; index < last; index++) {
        const weight = (Math.min(end, index + 1) - Math.max(start, index)) / (end - start);
        if (weight > 0) result.push({ index, weight });
      }
      return result;
    }
    const coverage = Math.max(0, Math.min(out + 1, offset + source * ratio) - Math.max(out, offset));
    if (!coverage) return [];
    const center = (out + 0.5 - offset) / ratio - 0.5;
    const first = Math.floor(center), fraction = center - first;
    const clamp = (index) => Math.max(0, Math.min(source - 1, index));
    return [
      { index: clamp(first), weight: (1 - fraction) * coverage },
      { index: clamp(first + 1), weight: fraction * coverage }
    ];
  });
}
function rasterizeImageFill(contents, mode, width, height, scale) {
  if (mode !== "FILL" && mode !== "FIT") throw new Error("IMAGE \u586B\u5145\u4EC5\u652F\u6301\u6807\u51C6\u4E2D\u5FC3 FILL/FIT\u3002");
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("IMAGE \u586B\u5145\u5BBD\u9AD8\u548C\u500D\u7387\u5FC5\u987B\u4E3A\u6709\u9650\u6B63\u6570\u3002");
  }
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  dimensions(targetWidth, targetHeight);
  if (!contents.length || contents.length > MAX_BYTES) throw new Error("IMAGE \u6E90\u56FE\u7247\u4E3A\u7A7A\u6216\u8D85\u8FC7 64 MB\u3002");
  const png = contents.subarray(0, 8).equals(SIGNATURE) ? contents : decodeToPng(contents);
  const header = inspect(png);
  const input = import_pngjs.PNG.sync.read(png, { checkCRC: true });
  if (targetWidth === header.width && targetHeight === header.height) return png;
  const ratio = mode === "FILL" ? Math.max(targetWidth / header.width, targetHeight / header.height) : Math.min(targetWidth / header.width, targetHeight / header.height);
  const offsetX = (targetWidth - header.width * ratio) / 2;
  const offsetY = (targetHeight - header.height * ratio) / 2;
  const xs = samples(header.width, targetWidth, ratio, offsetX);
  const ys = samples(header.height, targetHeight, ratio, offsetY);
  const output = new import_pngjs.PNG({ width: targetWidth, height: targetHeight });
  for (let y = 0; y < targetHeight; y++) {
    if (!ys[y].length) continue;
    for (let x = 0; x < targetWidth; x++) {
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (const sy of ys[y]) for (const sx of xs[x]) {
        const source = (sy.index * header.width + sx.index) * 4;
        const a = input.data[source + 3] * sy.weight * sx.weight;
        alpha += a;
        red += input.data[source] * a;
        green += input.data[source + 1] * a;
        blue += input.data[source + 2] * a;
      }
      const target = (y * targetWidth + x) * 4;
      output.data[target + 3] = Math.round(alpha);
      if (output.data[target + 3] > 0) {
        output.data[target] = Math.round(red / alpha);
        output.data[target + 1] = Math.round(green / alpha);
        output.data[target + 2] = Math.round(blue / alpha);
      }
    }
  }
  const encoded = import_pngjs.PNG.sync.write(output);
  return header.metadata.length ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  rasterizeImageFill
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9jaHVua3N0cmVhbS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ludGVybGFjZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhZXRoLXByZWRpY3Rvci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1hc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NvbnN0YW50cy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NyYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhcnNlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2JpdG1hcHBlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2Zvcm1hdC1ub3JtYWxpc2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLWFzeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvYml0cGFja2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvZmlsdGVyLXBhY2suanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXIuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItYXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLWluZmxhdGUuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLXJlYWRlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BuZy1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcG5nLmpzIiwgIi4uLy4uL3NvdXJjZS9pbXBvcnRlci9pbWFnZS1maWxsLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xuXG5sZXQgQ2h1bmtTdHJlYW0gPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoKSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIHRoaXMuX2J1ZmZlcnMgPSBbXTtcbiAgdGhpcy5fYnVmZmVyZWQgPSAwO1xuXG4gIHRoaXMuX3JlYWRzID0gW107XG4gIHRoaXMuX3BhdXNlZCA9IGZhbHNlO1xuXG4gIHRoaXMuX2VuY29kaW5nID0gXCJ1dGY4XCI7XG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xufSk7XG51dGlsLmluaGVyaXRzKENodW5rU3RyZWFtLCBTdHJlYW0pO1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUucmVhZCA9IGZ1bmN0aW9uIChsZW5ndGgsIGNhbGxiYWNrKSB7XG4gIHRoaXMuX3JlYWRzLnB1c2goe1xuICAgIGxlbmd0aDogTWF0aC5hYnMobGVuZ3RoKSwgLy8gaWYgbGVuZ3RoIDwgMCB0aGVuIGF0IG1vc3QgdGhpcyBsZW5ndGhcbiAgICBhbGxvd0xlc3M6IGxlbmd0aCA8IDAsXG4gICAgZnVuYzogY2FsbGJhY2ssXG4gIH0pO1xuXG4gIHByb2Nlc3MubmV4dFRpY2soXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5fcHJvY2VzcygpO1xuXG4gICAgICAvLyBpdHMgcGF1c2VkIGFuZCB0aGVyZSBpcyBub3QgZW5vdWdodCBkYXRhIHRoZW4gYXNrIGZvciBtb3JlXG4gICAgICBpZiAodGhpcy5fcGF1c2VkICYmIHRoaXMuX3JlYWRzICYmIHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgdGhpcy5fcGF1c2VkID0gZmFsc2U7XG5cbiAgICAgICAgdGhpcy5lbWl0KFwiZHJhaW5cIik7XG4gICAgICB9XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSwgZW5jb2RpbmcpIHtcbiAgaWYgKCF0aGlzLndyaXRhYmxlKSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgbmV3IEVycm9yKFwiU3RyZWFtIG5vdCB3cml0YWJsZVwiKSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgbGV0IGRhdGFCdWZmZXI7XG4gIGlmIChCdWZmZXIuaXNCdWZmZXIoZGF0YSkpIHtcbiAgICBkYXRhQnVmZmVyID0gZGF0YTtcbiAgfSBlbHNlIHtcbiAgICBkYXRhQnVmZmVyID0gQnVmZmVyLmZyb20oZGF0YSwgZW5jb2RpbmcgfHwgdGhpcy5fZW5jb2RpbmcpO1xuICB9XG5cbiAgdGhpcy5fYnVmZmVycy5wdXNoKGRhdGFCdWZmZXIpO1xuICB0aGlzLl9idWZmZXJlZCArPSBkYXRhQnVmZmVyLmxlbmd0aDtcblxuICB0aGlzLl9wcm9jZXNzKCk7XG5cbiAgLy8gb2sgaWYgdGhlcmUgYXJlIG5vIG1vcmUgcmVhZCByZXF1ZXN0c1xuICBpZiAodGhpcy5fcmVhZHMgJiYgdGhpcy5fcmVhZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhpcy5fcGF1c2VkID0gdHJ1ZTtcbiAgfVxuXG4gIHJldHVybiB0aGlzLndyaXRhYmxlICYmICF0aGlzLl9wYXVzZWQ7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuZW5kID0gZnVuY3Rpb24gKGRhdGEsIGVuY29kaW5nKSB7XG4gIGlmIChkYXRhKSB7XG4gICAgdGhpcy53cml0ZShkYXRhLCBlbmNvZGluZyk7XG4gIH1cblxuICB0aGlzLndyaXRhYmxlID0gZmFsc2U7XG5cbiAgLy8gYWxyZWFkeSBkZXN0cm95ZWRcbiAgaWYgKCF0aGlzLl9idWZmZXJzKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gZW5xdWV1ZSBvciBoYW5kbGUgZW5kXG4gIGlmICh0aGlzLl9idWZmZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRoaXMuX2VuZCgpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2J1ZmZlcnMucHVzaChudWxsKTtcbiAgICB0aGlzLl9wcm9jZXNzKCk7XG4gIH1cbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5kZXN0cm95U29vbiA9IENodW5rU3RyZWFtLnByb3RvdHlwZS5lbmQ7XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fZW5kID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIG5ldyBFcnJvcihcIlVuZXhwZWN0ZWQgZW5kIG9mIGlucHV0XCIpKTtcbiAgfVxuXG4gIHRoaXMuZGVzdHJveSgpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmRlc3Ryb3kgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICghdGhpcy5fYnVmZmVycykge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcbiAgdGhpcy5fcmVhZHMgPSBudWxsO1xuICB0aGlzLl9idWZmZXJzID0gbnVsbDtcblxuICB0aGlzLmVtaXQoXCJjbG9zZVwiKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2Vzc1JlYWRBbGxvd2luZ0xlc3MgPSBmdW5jdGlvbiAocmVhZCkge1xuICAvLyBvayB0aGVyZSBpcyBhbnkgZGF0YSBzbyB0aGF0IHdlIGNhbiBzYXRpc2Z5IHRoaXMgcmVxdWVzdFxuICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgLy8gZmlyc3Qgd2UgbmVlZCB0byBwZWVrIGludG8gZmlyc3QgYnVmZmVyXG4gIGxldCBzbWFsbGVyQnVmID0gdGhpcy5fYnVmZmVyc1swXTtcblxuICAvLyBvayB0aGVyZSBpcyBtb3JlIGRhdGEgdGhhbiB3ZSBuZWVkXG4gIGlmIChzbWFsbGVyQnVmLmxlbmd0aCA+IHJlYWQubGVuZ3RoKSB7XG4gICAgdGhpcy5fYnVmZmVyZWQgLT0gcmVhZC5sZW5ndGg7XG4gICAgdGhpcy5fYnVmZmVyc1swXSA9IHNtYWxsZXJCdWYuc2xpY2UocmVhZC5sZW5ndGgpO1xuXG4gICAgcmVhZC5mdW5jLmNhbGwodGhpcywgc21hbGxlckJ1Zi5zbGljZSgwLCByZWFkLmxlbmd0aCkpO1xuICB9IGVsc2Uge1xuICAgIC8vIG9rIHRoaXMgaXMgbGVzcyB0aGFuIG1heGltdW0gbGVuZ3RoIHNvIHVzZSBpdCBhbGxcbiAgICB0aGlzLl9idWZmZXJlZCAtPSBzbWFsbGVyQnVmLmxlbmd0aDtcbiAgICB0aGlzLl9idWZmZXJzLnNoaWZ0KCk7IC8vID09IHNtYWxsZXJCdWZcblxuICAgIHJlYWQuZnVuYy5jYWxsKHRoaXMsIHNtYWxsZXJCdWYpO1xuICB9XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuX3Byb2Nlc3NSZWFkID0gZnVuY3Rpb24gKHJlYWQpIHtcbiAgdGhpcy5fcmVhZHMuc2hpZnQoKTsgLy8gPT0gcmVhZFxuXG4gIGxldCBwb3MgPSAwO1xuICBsZXQgY291bnQgPSAwO1xuICBsZXQgZGF0YSA9IEJ1ZmZlci5hbGxvYyhyZWFkLmxlbmd0aCk7XG5cbiAgLy8gY3JlYXRlIGJ1ZmZlciBmb3IgYWxsIGRhdGFcbiAgd2hpbGUgKHBvcyA8IHJlYWQubGVuZ3RoKSB7XG4gICAgbGV0IGJ1ZiA9IHRoaXMuX2J1ZmZlcnNbY291bnQrK107XG4gICAgbGV0IGxlbiA9IE1hdGgubWluKGJ1Zi5sZW5ndGgsIHJlYWQubGVuZ3RoIC0gcG9zKTtcblxuICAgIGJ1Zi5jb3B5KGRhdGEsIHBvcywgMCwgbGVuKTtcbiAgICBwb3MgKz0gbGVuO1xuXG4gICAgLy8gbGFzdCBidWZmZXIgd2Fzbid0IHVzZWQgYWxsIHNvIGp1c3Qgc2xpY2UgaXQgYW5kIGxlYXZlXG4gICAgaWYgKGxlbiAhPT0gYnVmLmxlbmd0aCkge1xuICAgICAgdGhpcy5fYnVmZmVyc1stLWNvdW50XSA9IGJ1Zi5zbGljZShsZW4pO1xuICAgIH1cbiAgfVxuXG4gIC8vIHJlbW92ZSBhbGwgdXNlZCBidWZmZXJzXG4gIGlmIChjb3VudCA+IDApIHtcbiAgICB0aGlzLl9idWZmZXJzLnNwbGljZSgwLCBjb3VudCk7XG4gIH1cblxuICB0aGlzLl9idWZmZXJlZCAtPSByZWFkLmxlbmd0aDtcblxuICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBkYXRhKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2VzcyA9IGZ1bmN0aW9uICgpIHtcbiAgdHJ5IHtcbiAgICAvLyBhcyBsb25nIGFzIHRoZXJlIGlzIGFueSBkYXRhIGFuZCByZWFkIHJlcXVlc3RzXG4gICAgd2hpbGUgKHRoaXMuX2J1ZmZlcmVkID4gMCAmJiB0aGlzLl9yZWFkcyAmJiB0aGlzLl9yZWFkcy5sZW5ndGggPiAwKSB7XG4gICAgICBsZXQgcmVhZCA9IHRoaXMuX3JlYWRzWzBdO1xuXG4gICAgICAvLyByZWFkIGFueSBkYXRhIChidXQgbm8gbW9yZSB0aGFuIGxlbmd0aClcbiAgICAgIGlmIChyZWFkLmFsbG93TGVzcykge1xuICAgICAgICB0aGlzLl9wcm9jZXNzUmVhZEFsbG93aW5nTGVzcyhyZWFkKTtcbiAgICAgIH0gZWxzZSBpZiAodGhpcy5fYnVmZmVyZWQgPj0gcmVhZC5sZW5ndGgpIHtcbiAgICAgICAgLy8gb2sgd2UgY2FuIG1lZXQgc29tZSBleHBlY3RhdGlvbnNcblxuICAgICAgICB0aGlzLl9wcm9jZXNzUmVhZChyZWFkKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIG5vdCBlbm91Z2h0IGRhdGEgdG8gc2F0aXNmeSBmaXJzdCByZXF1ZXN0IGluIHF1ZXVlXG4gICAgICAgIC8vIHNvIHdlIG5lZWQgdG8gd2FpdCBmb3IgbW9yZVxuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAodGhpcy5fYnVmZmVycyAmJiAhdGhpcy53cml0YWJsZSkge1xuICAgICAgdGhpcy5fZW5kKCk7XG4gICAgfVxuICB9IGNhdGNoIChleCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIGV4KTtcbiAgfVxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxuLy8gQWRhbSA3XG4vLyAgIDAgMSAyIDMgNCA1IDYgN1xuLy8gMCB4IDYgNCA2IHggNiA0IDZcbi8vIDEgNyA3IDcgNyA3IDcgNyA3XG4vLyAyIDUgNiA1IDYgNSA2IDUgNlxuLy8gMyA3IDcgNyA3IDcgNyA3IDdcbi8vIDQgMyA2IDQgNiAzIDYgNCA2XG4vLyA1IDcgNyA3IDcgNyA3IDcgN1xuLy8gNiA1IDYgNSA2IDUgNiA1IDZcbi8vIDcgNyA3IDcgNyA3IDcgNyA3XG5cbmxldCBpbWFnZVBhc3NlcyA9IFtcbiAge1xuICAgIC8vIHBhc3MgMSAtIDFweFxuICAgIHg6IFswXSxcbiAgICB5OiBbMF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDIgLSAxcHhcbiAgICB4OiBbNF0sXG4gICAgeTogWzBdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyAzIC0gMnB4XG4gICAgeDogWzAsIDRdLFxuICAgIHk6IFs0XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNCAtIDRweFxuICAgIHg6IFsyLCA2XSxcbiAgICB5OiBbMCwgNF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDUgLSA4cHhcbiAgICB4OiBbMCwgMiwgNCwgNl0sXG4gICAgeTogWzIsIDZdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyA2IC0gMTZweFxuICAgIHg6IFsxLCAzLCA1LCA3XSxcbiAgICB5OiBbMCwgMiwgNCwgNl0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDcgLSAzMnB4XG4gICAgeDogWzAsIDEsIDIsIDMsIDQsIDUsIDYsIDddLFxuICAgIHk6IFsxLCAzLCA1LCA3XSxcbiAgfSxcbl07XG5cbmV4cG9ydHMuZ2V0SW1hZ2VQYXNzZXMgPSBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICBsZXQgaW1hZ2VzID0gW107XG4gIGxldCB4TGVmdE92ZXIgPSB3aWR0aCAlIDg7XG4gIGxldCB5TGVmdE92ZXIgPSBoZWlnaHQgJSA4O1xuICBsZXQgeFJlcGVhdHMgPSAod2lkdGggLSB4TGVmdE92ZXIpIC8gODtcbiAgbGV0IHlSZXBlYXRzID0gKGhlaWdodCAtIHlMZWZ0T3ZlcikgLyA4O1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGltYWdlUGFzc2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgbGV0IHBhc3MgPSBpbWFnZVBhc3Nlc1tpXTtcbiAgICBsZXQgcGFzc1dpZHRoID0geFJlcGVhdHMgKiBwYXNzLngubGVuZ3RoO1xuICAgIGxldCBwYXNzSGVpZ2h0ID0geVJlcGVhdHMgKiBwYXNzLnkubGVuZ3RoO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgcGFzcy54Lmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAocGFzcy54W2pdIDwgeExlZnRPdmVyKSB7XG4gICAgICAgIHBhc3NXaWR0aCsrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGZvciAobGV0IGogPSAwOyBqIDwgcGFzcy55Lmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAocGFzcy55W2pdIDwgeUxlZnRPdmVyKSB7XG4gICAgICAgIHBhc3NIZWlnaHQrKztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAocGFzc1dpZHRoID4gMCAmJiBwYXNzSGVpZ2h0ID4gMCkge1xuICAgICAgaW1hZ2VzLnB1c2goeyB3aWR0aDogcGFzc1dpZHRoLCBoZWlnaHQ6IHBhc3NIZWlnaHQsIGluZGV4OiBpIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gaW1hZ2VzO1xufTtcblxuZXhwb3J0cy5nZXRJbnRlcmxhY2VJdGVyYXRvciA9IGZ1bmN0aW9uICh3aWR0aCkge1xuICByZXR1cm4gZnVuY3Rpb24gKHgsIHksIHBhc3MpIHtcbiAgICBsZXQgb3V0ZXJYTGVmdE92ZXIgPSB4ICUgaW1hZ2VQYXNzZXNbcGFzc10ueC5sZW5ndGg7XG4gICAgbGV0IG91dGVyWCA9XG4gICAgICAoKHggLSBvdXRlclhMZWZ0T3ZlcikgLyBpbWFnZVBhc3Nlc1twYXNzXS54Lmxlbmd0aCkgKiA4ICtcbiAgICAgIGltYWdlUGFzc2VzW3Bhc3NdLnhbb3V0ZXJYTGVmdE92ZXJdO1xuICAgIGxldCBvdXRlcllMZWZ0T3ZlciA9IHkgJSBpbWFnZVBhc3Nlc1twYXNzXS55Lmxlbmd0aDtcbiAgICBsZXQgb3V0ZXJZID1cbiAgICAgICgoeSAtIG91dGVyWUxlZnRPdmVyKSAvIGltYWdlUGFzc2VzW3Bhc3NdLnkubGVuZ3RoKSAqIDggK1xuICAgICAgaW1hZ2VQYXNzZXNbcGFzc10ueVtvdXRlcllMZWZ0T3Zlcl07XG4gICAgcmV0dXJuIG91dGVyWCAqIDQgKyBvdXRlclkgKiB3aWR0aCAqIDQ7XG4gIH07XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIHBhZXRoUHJlZGljdG9yKGxlZnQsIGFib3ZlLCB1cExlZnQpIHtcbiAgbGV0IHBhZXRoID0gbGVmdCArIGFib3ZlIC0gdXBMZWZ0O1xuICBsZXQgcExlZnQgPSBNYXRoLmFicyhwYWV0aCAtIGxlZnQpO1xuICBsZXQgcEFib3ZlID0gTWF0aC5hYnMocGFldGggLSBhYm92ZSk7XG4gIGxldCBwVXBMZWZ0ID0gTWF0aC5hYnMocGFldGggLSB1cExlZnQpO1xuXG4gIGlmIChwTGVmdCA8PSBwQWJvdmUgJiYgcExlZnQgPD0gcFVwTGVmdCkge1xuICAgIHJldHVybiBsZWZ0O1xuICB9XG4gIGlmIChwQWJvdmUgPD0gcFVwTGVmdCkge1xuICAgIHJldHVybiBhYm92ZTtcbiAgfVxuICByZXR1cm4gdXBMZWZ0O1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGludGVybGFjZVV0aWxzID0gcmVxdWlyZShcIi4vaW50ZXJsYWNlXCIpO1xubGV0IHBhZXRoUHJlZGljdG9yID0gcmVxdWlyZShcIi4vcGFldGgtcHJlZGljdG9yXCIpO1xuXG5mdW5jdGlvbiBnZXRCeXRlV2lkdGgod2lkdGgsIGJwcCwgZGVwdGgpIHtcbiAgbGV0IGJ5dGVXaWR0aCA9IHdpZHRoICogYnBwO1xuICBpZiAoZGVwdGggIT09IDgpIHtcbiAgICBieXRlV2lkdGggPSBNYXRoLmNlaWwoYnl0ZVdpZHRoIC8gKDggLyBkZXB0aCkpO1xuICB9XG4gIHJldHVybiBieXRlV2lkdGg7XG59XG5cbmxldCBGaWx0ZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYml0bWFwSW5mbywgZGVwZW5kZW5jaWVzKSB7XG4gIGxldCB3aWR0aCA9IGJpdG1hcEluZm8ud2lkdGg7XG4gIGxldCBoZWlnaHQgPSBiaXRtYXBJbmZvLmhlaWdodDtcbiAgbGV0IGludGVybGFjZSA9IGJpdG1hcEluZm8uaW50ZXJsYWNlO1xuICBsZXQgYnBwID0gYml0bWFwSW5mby5icHA7XG4gIGxldCBkZXB0aCA9IGJpdG1hcEluZm8uZGVwdGg7XG5cbiAgdGhpcy5yZWFkID0gZGVwZW5kZW5jaWVzLnJlYWQ7XG4gIHRoaXMud3JpdGUgPSBkZXBlbmRlbmNpZXMud3JpdGU7XG4gIHRoaXMuY29tcGxldGUgPSBkZXBlbmRlbmNpZXMuY29tcGxldGU7XG5cbiAgdGhpcy5faW1hZ2VJbmRleCA9IDA7XG4gIHRoaXMuX2ltYWdlcyA9IFtdO1xuICBpZiAoaW50ZXJsYWNlKSB7XG4gICAgbGV0IHBhc3NlcyA9IGludGVybGFjZVV0aWxzLmdldEltYWdlUGFzc2VzKHdpZHRoLCBoZWlnaHQpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcGFzc2VzLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLl9pbWFnZXMucHVzaCh7XG4gICAgICAgIGJ5dGVXaWR0aDogZ2V0Qnl0ZVdpZHRoKHBhc3Nlc1tpXS53aWR0aCwgYnBwLCBkZXB0aCksXG4gICAgICAgIGhlaWdodDogcGFzc2VzW2ldLmhlaWdodCxcbiAgICAgICAgbGluZUluZGV4OiAwLFxuICAgICAgfSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIHRoaXMuX2ltYWdlcy5wdXNoKHtcbiAgICAgIGJ5dGVXaWR0aDogZ2V0Qnl0ZVdpZHRoKHdpZHRoLCBicHAsIGRlcHRoKSxcbiAgICAgIGhlaWdodDogaGVpZ2h0LFxuICAgICAgbGluZUluZGV4OiAwLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gd2hlbiBmaWx0ZXJpbmcgdGhlIGxpbmUgd2UgbG9vayBhdCB0aGUgcGl4ZWwgdG8gdGhlIGxlZnRcbiAgLy8gdGhlIHNwZWMgYWxzbyBzYXlzIGl0IGlzIGRvbmUgb24gYSBieXRlIGxldmVsIHJlZ2FyZGxlc3Mgb2YgdGhlIG51bWJlciBvZiBwaXhlbHNcbiAgLy8gc28gaWYgdGhlIGRlcHRoIGlzIGJ5dGUgY29tcGF0aWJsZSAoOCBvciAxNikgd2Ugc3VidHJhY3QgdGhlIGJwcCBpbiBvcmRlciB0byBjb21wYXJlIGJhY2tcbiAgLy8gYSBwaXhlbCByYXRoZXIgdGhhbiBqdXN0IGEgZGlmZmVyZW50IGJ5dGUgcGFydC4gSG93ZXZlciBpZiB3ZSBhcmUgc3ViIGJ5dGUsIHdlIGlnbm9yZS5cbiAgaWYgKGRlcHRoID09PSA4KSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSBicHA7XG4gIH0gZWxzZSBpZiAoZGVwdGggPT09IDE2KSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSBicHAgKiAyO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX3hDb21wYXJpc29uID0gMTtcbiAgfVxufSk7XG5cbkZpbHRlci5wcm90b3R5cGUuc3RhcnQgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMucmVhZChcbiAgICB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF0uYnl0ZVdpZHRoICsgMSxcbiAgICB0aGlzLl9yZXZlcnNlRmlsdGVyTGluZS5iaW5kKHRoaXMpXG4gICk7XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUxID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjFMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgdW5maWx0ZXJlZExpbmVbeF0gPSByYXdCeXRlICsgZjFMZWZ0O1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUyID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGYyVXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmMlVwO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGUzID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGYzVXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICBsZXQgZjNMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGYzQWRkID0gTWF0aC5mbG9vcigoZjNMZWZ0ICsgZjNVcCkgLyAyKTtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmM0FkZDtcbiAgfVxufTtcblxuRmlsdGVyLnByb3RvdHlwZS5fdW5GaWx0ZXJUeXBlNCA9IGZ1bmN0aW9uIChcbiAgcmF3RGF0YSxcbiAgdW5maWx0ZXJlZExpbmUsXG4gIGJ5dGVXaWR0aFxuKSB7XG4gIGxldCB4Q29tcGFyaXNvbiA9IHRoaXMuX3hDb21wYXJpc29uO1xuICBsZXQgeEJpZ2dlclRoYW4gPSB4Q29tcGFyaXNvbiAtIDE7XG4gIGxldCBsYXN0TGluZSA9IHRoaXMuX2xhc3RMaW5lO1xuXG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgcmF3Qnl0ZSA9IHJhd0RhdGFbMSArIHhdO1xuICAgIGxldCBmNFVwID0gbGFzdExpbmUgPyBsYXN0TGluZVt4XSA6IDA7XG4gICAgbGV0IGY0TGVmdCA9IHggPiB4QmlnZ2VyVGhhbiA/IHVuZmlsdGVyZWRMaW5lW3ggLSB4Q29tcGFyaXNvbl0gOiAwO1xuICAgIGxldCBmNFVwTGVmdCA9IHggPiB4QmlnZ2VyVGhhbiAmJiBsYXN0TGluZSA/IGxhc3RMaW5lW3ggLSB4Q29tcGFyaXNvbl0gOiAwO1xuICAgIGxldCBmNEFkZCA9IHBhZXRoUHJlZGljdG9yKGY0TGVmdCwgZjRVcCwgZjRVcExlZnQpO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGY0QWRkO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl9yZXZlcnNlRmlsdGVyTGluZSA9IGZ1bmN0aW9uIChyYXdEYXRhKSB7XG4gIGxldCBmaWx0ZXIgPSByYXdEYXRhWzBdO1xuICBsZXQgdW5maWx0ZXJlZExpbmU7XG4gIGxldCBjdXJyZW50SW1hZ2UgPSB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF07XG4gIGxldCBieXRlV2lkdGggPSBjdXJyZW50SW1hZ2UuYnl0ZVdpZHRoO1xuXG4gIGlmIChmaWx0ZXIgPT09IDApIHtcbiAgICB1bmZpbHRlcmVkTGluZSA9IHJhd0RhdGEuc2xpY2UoMSwgYnl0ZVdpZHRoICsgMSk7XG4gIH0gZWxzZSB7XG4gICAgdW5maWx0ZXJlZExpbmUgPSBCdWZmZXIuYWxsb2MoYnl0ZVdpZHRoKTtcblxuICAgIHN3aXRjaCAoZmlsdGVyKSB7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTEocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICB0aGlzLl91bkZpbHRlclR5cGUyKHJhd0RhdGEsIHVuZmlsdGVyZWRMaW5lLCBieXRlV2lkdGgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMzpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlMyhyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDQ6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTQocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiVW5yZWNvZ25pc2VkIGZpbHRlciB0eXBlIC0gXCIgKyBmaWx0ZXIpO1xuICAgIH1cbiAgfVxuXG4gIHRoaXMud3JpdGUodW5maWx0ZXJlZExpbmUpO1xuXG4gIGN1cnJlbnRJbWFnZS5saW5lSW5kZXgrKztcbiAgaWYgKGN1cnJlbnRJbWFnZS5saW5lSW5kZXggPj0gY3VycmVudEltYWdlLmhlaWdodCkge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gbnVsbDtcbiAgICB0aGlzLl9pbWFnZUluZGV4Kys7XG4gICAgY3VycmVudEltYWdlID0gdGhpcy5faW1hZ2VzW3RoaXMuX2ltYWdlSW5kZXhdO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gdW5maWx0ZXJlZExpbmU7XG4gIH1cblxuICBpZiAoY3VycmVudEltYWdlKSB7XG4gICAgLy8gcmVhZCwgdXNpbmcgdGhlIGJ5dGUgd2lkdGggdGhhdCBtYXkgYmUgZnJvbSB0aGUgbmV3IGN1cnJlbnQgaW1hZ2VcbiAgICB0aGlzLnJlYWQoY3VycmVudEltYWdlLmJ5dGVXaWR0aCArIDEsIHRoaXMuX3JldmVyc2VGaWx0ZXJMaW5lLmJpbmQodGhpcykpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2xhc3RMaW5lID0gbnVsbDtcbiAgICB0aGlzLmNvbXBsZXRlKCk7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgQ2h1bmtTdHJlYW0gPSByZXF1aXJlKFwiLi9jaHVua3N0cmVhbVwiKTtcbmxldCBGaWx0ZXIgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFyc2VcIik7XG5cbmxldCBGaWx0ZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChiaXRtYXBJbmZvKSB7XG4gIENodW5rU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgbGV0IGJ1ZmZlcnMgPSBbXTtcbiAgbGV0IHRoYXQgPSB0aGlzO1xuICB0aGlzLl9maWx0ZXIgPSBuZXcgRmlsdGVyKGJpdG1hcEluZm8sIHtcbiAgICByZWFkOiB0aGlzLnJlYWQuYmluZCh0aGlzKSxcbiAgICB3cml0ZTogZnVuY3Rpb24gKGJ1ZmZlcikge1xuICAgICAgYnVmZmVycy5wdXNoKGJ1ZmZlcik7XG4gICAgfSxcbiAgICBjb21wbGV0ZTogZnVuY3Rpb24gKCkge1xuICAgICAgdGhhdC5lbWl0KFwiY29tcGxldGVcIiwgQnVmZmVyLmNvbmNhdChidWZmZXJzKSk7XG4gICAgfSxcbiAgfSk7XG5cbiAgdGhpcy5fZmlsdGVyLnN0YXJ0KCk7XG59KTtcbnV0aWwuaW5oZXJpdHMoRmlsdGVyQXN5bmMsIENodW5rU3RyZWFtKTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIFBOR19TSUdOQVRVUkU6IFsweDg5LCAweDUwLCAweDRlLCAweDQ3LCAweDBkLCAweDBhLCAweDFhLCAweDBhXSxcblxuICBUWVBFX0lIRFI6IDB4NDk0ODQ0NTIsXG4gIFRZUEVfSUVORDogMHg0OTQ1NGU0NCxcbiAgVFlQRV9JREFUOiAweDQ5NDQ0MTU0LFxuICBUWVBFX1BMVEU6IDB4NTA0YzU0NDUsXG4gIFRZUEVfdFJOUzogMHg3NDUyNGU1MywgLy8gZXNsaW50LWRpc2FibGUtbGluZSBjYW1lbGNhc2VcbiAgVFlQRV9nQU1BOiAweDY3NDE0ZDQxLCAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIGNhbWVsY2FzZVxuXG4gIC8vIGNvbG9yLXR5cGUgYml0c1xuICBDT0xPUlRZUEVfR1JBWVNDQUxFOiAwLFxuICBDT0xPUlRZUEVfUEFMRVRURTogMSxcbiAgQ09MT1JUWVBFX0NPTE9SOiAyLFxuICBDT0xPUlRZUEVfQUxQSEE6IDQsIC8vIGUuZy4gZ3JheXNjYWxlIGFuZCBhbHBoYVxuXG4gIC8vIGNvbG9yLXR5cGUgY29tYmluYXRpb25zXG4gIENPTE9SVFlQRV9QQUxFVFRFX0NPTE9SOiAzLFxuICBDT0xPUlRZUEVfQ09MT1JfQUxQSEE6IDYsXG5cbiAgQ09MT1JUWVBFX1RPX0JQUF9NQVA6IHtcbiAgICAwOiAxLFxuICAgIDI6IDMsXG4gICAgMzogMSxcbiAgICA0OiAyLFxuICAgIDY6IDQsXG4gIH0sXG5cbiAgR0FNTUFfRElWSVNJT046IDEwMDAwMCxcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjcmNUYWJsZSA9IFtdO1xuXG4oZnVuY3Rpb24gKCkge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IDI1NjsgaSsrKSB7XG4gICAgbGV0IGN1cnJlbnRDcmMgPSBpO1xuICAgIGZvciAobGV0IGogPSAwOyBqIDwgODsgaisrKSB7XG4gICAgICBpZiAoY3VycmVudENyYyAmIDEpIHtcbiAgICAgICAgY3VycmVudENyYyA9IDB4ZWRiODgzMjAgXiAoY3VycmVudENyYyA+Pj4gMSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjdXJyZW50Q3JjID0gY3VycmVudENyYyA+Pj4gMTtcbiAgICAgIH1cbiAgICB9XG4gICAgY3JjVGFibGVbaV0gPSBjdXJyZW50Q3JjO1xuICB9XG59KSgpO1xuXG5sZXQgQ3JjQ2FsY3VsYXRvciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5fY3JjID0gLTE7XG59KTtcblxuQ3JjQ2FsY3VsYXRvci5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICB0aGlzLl9jcmMgPSBjcmNUYWJsZVsodGhpcy5fY3JjIF4gZGF0YVtpXSkgJiAweGZmXSBeICh0aGlzLl9jcmMgPj4+IDgpO1xuICB9XG4gIHJldHVybiB0cnVlO1xufTtcblxuQ3JjQ2FsY3VsYXRvci5wcm90b3R5cGUuY3JjMzIgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB0aGlzLl9jcmMgXiAtMTtcbn07XG5cbkNyY0NhbGN1bGF0b3IuY3JjMzIgPSBmdW5jdGlvbiAoYnVmKSB7XG4gIGxldCBjcmMgPSAtMTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBidWYubGVuZ3RoOyBpKyspIHtcbiAgICBjcmMgPSBjcmNUYWJsZVsoY3JjIF4gYnVmW2ldKSAmIDB4ZmZdIF4gKGNyYyA+Pj4gOCk7XG4gIH1cbiAgcmV0dXJuIGNyYyBeIC0xO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcbmxldCBDcmNDYWxjdWxhdG9yID0gcmVxdWlyZShcIi4vY3JjXCIpO1xuXG5sZXQgUGFyc2VyID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9wdGlvbnMsIGRlcGVuZGVuY2llcykge1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgb3B0aW9ucy5jaGVja0NSQyA9IG9wdGlvbnMuY2hlY2tDUkMgIT09IGZhbHNlO1xuXG4gIHRoaXMuX2hhc0lIRFIgPSBmYWxzZTtcbiAgdGhpcy5faGFzSUVORCA9IGZhbHNlO1xuICB0aGlzLl9lbWl0dGVkSGVhZGVyc0ZpbmlzaGVkID0gZmFsc2U7XG5cbiAgLy8gaW5wdXQgZmxhZ3MvbWV0YWRhdGFcbiAgdGhpcy5fcGFsZXR0ZSA9IFtdO1xuICB0aGlzLl9jb2xvclR5cGUgPSAwO1xuXG4gIHRoaXMuX2NodW5rcyA9IHt9O1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfSUhEUl0gPSB0aGlzLl9oYW5kbGVJSERSLmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9JRU5EXSA9IHRoaXMuX2hhbmRsZUlFTkQuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX0lEQVRdID0gdGhpcy5faGFuZGxlSURBVC5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfUExURV0gPSB0aGlzLl9oYW5kbGVQTFRFLmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV90Uk5TXSA9IHRoaXMuX2hhbmRsZVRSTlMuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX2dBTUFdID0gdGhpcy5faGFuZGxlR0FNQS5iaW5kKHRoaXMpO1xuXG4gIHRoaXMucmVhZCA9IGRlcGVuZGVuY2llcy5yZWFkO1xuICB0aGlzLmVycm9yID0gZGVwZW5kZW5jaWVzLmVycm9yO1xuICB0aGlzLm1ldGFkYXRhID0gZGVwZW5kZW5jaWVzLm1ldGFkYXRhO1xuICB0aGlzLmdhbW1hID0gZGVwZW5kZW5jaWVzLmdhbW1hO1xuICB0aGlzLnRyYW5zQ29sb3IgPSBkZXBlbmRlbmNpZXMudHJhbnNDb2xvcjtcbiAgdGhpcy5wYWxldHRlID0gZGVwZW5kZW5jaWVzLnBhbGV0dGU7XG4gIHRoaXMucGFyc2VkID0gZGVwZW5kZW5jaWVzLnBhcnNlZDtcbiAgdGhpcy5pbmZsYXRlRGF0YSA9IGRlcGVuZGVuY2llcy5pbmZsYXRlRGF0YTtcbiAgdGhpcy5maW5pc2hlZCA9IGRlcGVuZGVuY2llcy5maW5pc2hlZDtcbiAgdGhpcy5zaW1wbGVUcmFuc3BhcmVuY3kgPSBkZXBlbmRlbmNpZXMuc2ltcGxlVHJhbnNwYXJlbmN5O1xuICB0aGlzLmhlYWRlcnNGaW5pc2hlZCA9IGRlcGVuZGVuY2llcy5oZWFkZXJzRmluaXNoZWQgfHwgZnVuY3Rpb24gKCkge307XG59KTtcblxuUGFyc2VyLnByb3RvdHlwZS5zdGFydCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFLmxlbmd0aCwgdGhpcy5fcGFyc2VTaWduYXR1cmUuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVNpZ25hdHVyZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIGxldCBzaWduYXR1cmUgPSBjb25zdGFudHMuUE5HX1NJR05BVFVSRTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHNpZ25hdHVyZS5sZW5ndGg7IGkrKykge1xuICAgIGlmIChkYXRhW2ldICE9PSBzaWduYXR1cmVbaV0pIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiSW52YWxpZCBmaWxlIHNpZ25hdHVyZVwiKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICB9XG4gIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUNodW5rQmVnaW4gPSBmdW5jdGlvbiAoZGF0YSkge1xuICAvLyBjaHVuayBjb250ZW50IGxlbmd0aFxuICBsZXQgbGVuZ3RoID0gZGF0YS5yZWFkVUludDMyQkUoMCk7XG5cbiAgLy8gY2h1bmsgdHlwZVxuICBsZXQgdHlwZSA9IGRhdGEucmVhZFVJbnQzMkJFKDQpO1xuICBsZXQgbmFtZSA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSA0OyBpIDwgODsgaSsrKSB7XG4gICAgbmFtZSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGRhdGFbaV0pO1xuICB9XG5cbiAgLy9jb25zb2xlLmxvZygnY2h1bmsgJywgbmFtZSwgbGVuZ3RoKTtcblxuICAvLyBjaHVuayBmbGFnc1xuICBsZXQgYW5jaWxsYXJ5ID0gQm9vbGVhbihkYXRhWzRdICYgMHgyMCk7IC8vIG9yIGNyaXRpY2FsXG4gIC8vICAgIHByaXYgPSBCb29sZWFuKGRhdGFbNV0gJiAweDIwKSwgLy8gb3IgcHVibGljXG4gIC8vICAgIHNhZmVUb0NvcHkgPSBCb29sZWFuKGRhdGFbN10gJiAweDIwKTsgLy8gb3IgdW5zYWZlXG5cbiAgaWYgKCF0aGlzLl9oYXNJSERSICYmIHR5cGUgIT09IGNvbnN0YW50cy5UWVBFX0lIRFIpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIkV4cGVjdGVkIElIRFIgb24gYmVnZ2luaW5nXCIpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aGlzLl9jcmMgPSBuZXcgQ3JjQ2FsY3VsYXRvcigpO1xuICB0aGlzLl9jcmMud3JpdGUoQnVmZmVyLmZyb20obmFtZSkpO1xuXG4gIGlmICh0aGlzLl9jaHVua3NbdHlwZV0pIHtcbiAgICByZXR1cm4gdGhpcy5fY2h1bmtzW3R5cGVdKGxlbmd0aCk7XG4gIH1cblxuICBpZiAoIWFuY2lsbGFyeSkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgY3JpdGljYWwgY2h1bmsgdHlwZSBcIiArIG5hbWUpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICB0aGlzLnJlYWQobGVuZ3RoICsgNCwgdGhpcy5fc2tpcENodW5rLmJpbmQodGhpcykpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5fc2tpcENodW5rID0gZnVuY3Rpb24gKC8qZGF0YSovKSB7XG4gIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVDaHVua0VuZCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKDQsIHRoaXMuX3BhcnNlQ2h1bmtFbmQuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUNodW5rRW5kID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgbGV0IGZpbGVDcmMgPSBkYXRhLnJlYWRJbnQzMkJFKDApO1xuICBsZXQgY2FsY0NyYyA9IHRoaXMuX2NyYy5jcmMzMigpO1xuXG4gIC8vIGNoZWNrIENSQ1xuICBpZiAodGhpcy5fb3B0aW9ucy5jaGVja0NSQyAmJiBjYWxjQ3JjICE9PSBmaWxlQ3JjKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJDcmMgZXJyb3IgLSBcIiArIGZpbGVDcmMgKyBcIiAtIFwiICsgY2FsY0NyYykpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5faGFzSUVORCkge1xuICAgIHRoaXMucmVhZCg4LCB0aGlzLl9wYXJzZUNodW5rQmVnaW4uYmluZCh0aGlzKSk7XG4gIH1cbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlIRFIgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlSUhEUi5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlIRFIgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgbGV0IHdpZHRoID0gZGF0YS5yZWFkVUludDMyQkUoMCk7XG4gIGxldCBoZWlnaHQgPSBkYXRhLnJlYWRVSW50MzJCRSg0KTtcbiAgbGV0IGRlcHRoID0gZGF0YVs4XTtcbiAgbGV0IGNvbG9yVHlwZSA9IGRhdGFbOV07IC8vIGJpdHM6IDEgcGFsZXR0ZSwgMiBjb2xvciwgNCBhbHBoYVxuICBsZXQgY29tcHIgPSBkYXRhWzEwXTtcbiAgbGV0IGZpbHRlciA9IGRhdGFbMTFdO1xuICBsZXQgaW50ZXJsYWNlID0gZGF0YVsxMl07XG5cbiAgLy8gY29uc29sZS5sb2coJyAgICB3aWR0aCcsIHdpZHRoLCAnaGVpZ2h0JywgaGVpZ2h0LFxuICAvLyAgICAgJ2RlcHRoJywgZGVwdGgsICdjb2xvclR5cGUnLCBjb2xvclR5cGUsXG4gIC8vICAgICAnY29tcHInLCBjb21wciwgJ2ZpbHRlcicsIGZpbHRlciwgJ2ludGVybGFjZScsIGludGVybGFjZVxuICAvLyApO1xuXG4gIGlmIChcbiAgICBkZXB0aCAhPT0gOCAmJlxuICAgIGRlcHRoICE9PSA0ICYmXG4gICAgZGVwdGggIT09IDIgJiZcbiAgICBkZXB0aCAhPT0gMSAmJlxuICAgIGRlcHRoICE9PSAxNlxuICApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGJpdCBkZXB0aCBcIiArIGRlcHRoKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmICghKGNvbG9yVHlwZSBpbiBjb25zdGFudHMuQ09MT1JUWVBFX1RPX0JQUF9NQVApKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjb2xvciB0eXBlXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGNvbXByICE9PSAwKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjb21wcmVzc2lvbiBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoZmlsdGVyICE9PSAwKSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBmaWx0ZXIgbWV0aG9kXCIpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKGludGVybGFjZSAhPT0gMCAmJiBpbnRlcmxhY2UgIT09IDEpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGludGVybGFjZSBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuX2NvbG9yVHlwZSA9IGNvbG9yVHlwZTtcblxuICBsZXQgYnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW3RoaXMuX2NvbG9yVHlwZV07XG5cbiAgdGhpcy5faGFzSUhEUiA9IHRydWU7XG5cbiAgdGhpcy5tZXRhZGF0YSh7XG4gICAgd2lkdGg6IHdpZHRoLFxuICAgIGhlaWdodDogaGVpZ2h0LFxuICAgIGRlcHRoOiBkZXB0aCxcbiAgICBpbnRlcmxhY2U6IEJvb2xlYW4oaW50ZXJsYWNlKSxcbiAgICBwYWxldHRlOiBCb29sZWFuKGNvbG9yVHlwZSAmIGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURSksXG4gICAgY29sb3I6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUiksXG4gICAgYWxwaGE6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSksXG4gICAgYnBwOiBicHAsXG4gICAgY29sb3JUeXBlOiBjb2xvclR5cGUsXG4gIH0pO1xuXG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVQTFRFID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICB0aGlzLnJlYWQobGVuZ3RoLCB0aGlzLl9wYXJzZVBMVEUuYmluZCh0aGlzKSk7XG59O1xuUGFyc2VyLnByb3RvdHlwZS5fcGFyc2VQTFRFID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIGxldCBlbnRyaWVzID0gTWF0aC5mbG9vcihkYXRhLmxlbmd0aCAvIDMpO1xuICAvLyBjb25zb2xlLmxvZygnUGFsZXR0ZTonLCBlbnRyaWVzKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IGVudHJpZXM7IGkrKykge1xuICAgIHRoaXMuX3BhbGV0dGUucHVzaChbZGF0YVtpICogM10sIGRhdGFbaSAqIDMgKyAxXSwgZGF0YVtpICogMyArIDJdLCAweGZmXSk7XG4gIH1cblxuICB0aGlzLnBhbGV0dGUodGhpcy5fcGFsZXR0ZSk7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZVRSTlMgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMuc2ltcGxlVHJhbnNwYXJlbmN5KCk7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlVFJOUy5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVRSTlMgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgLy8gcGFsZXR0ZVxuICBpZiAodGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1IpIHtcbiAgICBpZiAodGhpcy5fcGFsZXR0ZS5sZW5ndGggPT09IDApIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVHJhbnNwYXJlbmN5IGNodW5rIG11c3QgYmUgYWZ0ZXIgcGFsZXR0ZVwiKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChkYXRhLmxlbmd0aCA+IHRoaXMuX3BhbGV0dGUubGVuZ3RoKSB7XG4gICAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIk1vcmUgdHJhbnNwYXJlbnQgY29sb3JzIHRoYW4gcGFsZXR0ZSBzaXplXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBkYXRhLmxlbmd0aDsgaSsrKSB7XG4gICAgICB0aGlzLl9wYWxldHRlW2ldWzNdID0gZGF0YVtpXTtcbiAgICB9XG4gICAgdGhpcy5wYWxldHRlKHRoaXMuX3BhbGV0dGUpO1xuICB9XG5cbiAgLy8gZm9yIGNvbG9yVHlwZSAwIChncmF5c2NhbGUpIGFuZCAyIChyZ2IpXG4gIC8vIHRoZXJlIG1pZ2h0IGJlIG9uZSBncmF5L2NvbG9yIGRlZmluZWQgYXMgdHJhbnNwYXJlbnRcbiAgaWYgKHRoaXMuX2NvbG9yVHlwZSA9PT0gY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEUpIHtcbiAgICAvLyBncmV5LCAyIGJ5dGVzXG4gICAgdGhpcy50cmFuc0NvbG9yKFtkYXRhLnJlYWRVSW50MTZCRSgwKV0pO1xuICB9XG4gIGlmICh0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IpIHtcbiAgICB0aGlzLnRyYW5zQ29sb3IoW1xuICAgICAgZGF0YS5yZWFkVUludDE2QkUoMCksXG4gICAgICBkYXRhLnJlYWRVSW50MTZCRSgyKSxcbiAgICAgIGRhdGEucmVhZFVJbnQxNkJFKDQpLFxuICAgIF0pO1xuICB9XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUdBTUEgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlR0FNQS5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUdBTUEgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG4gIHRoaXMuZ2FtbWEoZGF0YS5yZWFkVUludDMyQkUoMCkgLyBjb25zdGFudHMuR0FNTUFfRElWSVNJT04pO1xuXG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVJREFUID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICBpZiAoIXRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQpIHtcbiAgICB0aGlzLl9lbWl0dGVkSGVhZGVyc0ZpbmlzaGVkID0gdHJ1ZTtcbiAgICB0aGlzLmhlYWRlcnNGaW5pc2hlZCgpO1xuICB9XG4gIHRoaXMucmVhZCgtbGVuZ3RoLCB0aGlzLl9wYXJzZUlEQVQuYmluZCh0aGlzLCBsZW5ndGgpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlEQVQgPSBmdW5jdGlvbiAobGVuZ3RoLCBkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICBpZiAoXG4gICAgdGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1IgJiZcbiAgICB0aGlzLl9wYWxldHRlLmxlbmd0aCA9PT0gMFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCBwYWxldHRlIG5vdCBmb3VuZFwiKTtcbiAgfVxuXG4gIHRoaXMuaW5mbGF0ZURhdGEoZGF0YSk7XG4gIGxldCBsZWZ0T3Zlckxlbmd0aCA9IGxlbmd0aCAtIGRhdGEubGVuZ3RoO1xuXG4gIGlmIChsZWZ0T3Zlckxlbmd0aCA+IDApIHtcbiAgICB0aGlzLl9oYW5kbGVJREFUKGxlZnRPdmVyTGVuZ3RoKTtcbiAgfSBlbHNlIHtcbiAgICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xuICB9XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9oYW5kbGVJRU5EID0gZnVuY3Rpb24gKGxlbmd0aCkge1xuICB0aGlzLnJlYWQobGVuZ3RoLCB0aGlzLl9wYXJzZUlFTkQuYmluZCh0aGlzKSk7XG59O1xuUGFyc2VyLnByb3RvdHlwZS5fcGFyc2VJRU5EID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIHRoaXMuX2hhc0lFTkQgPSB0cnVlO1xuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xuXG4gIGlmICh0aGlzLmZpbmlzaGVkKSB7XG4gICAgdGhpcy5maW5pc2hlZCgpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaW50ZXJsYWNlVXRpbHMgPSByZXF1aXJlKFwiLi9pbnRlcmxhY2VcIik7XG5cbmxldCBwaXhlbEJwcE1hcHBlciA9IFtcbiAgLy8gMCAtIGR1bW15IGVudHJ5XG4gIGZ1bmN0aW9uICgpIHt9LFxuXG4gIC8vIDEgLSBMXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgPT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgbGV0IHBpeGVsID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSAweGZmO1xuICB9LFxuXG4gIC8vIDIgLSBMQVxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAxXG4gIGZ1bmN0aW9uIChweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpIHtcbiAgICBpZiAocmF3UG9zICsgMSA+PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUmFuIG91dCBvZiBkYXRhXCIpO1xuICAgIH1cblxuICAgIGxldCBwaXhlbCA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gZGF0YVtyYXdQb3MgKyAxXTtcbiAgfSxcblxuICAvLyAzIC0gUkdCXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAyID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgcHhEYXRhW3B4UG9zXSA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IGRhdGFbcmF3UG9zICsgMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBkYXRhW3Jhd1BvcyArIDJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gMHhmZjtcbiAgfSxcblxuICAvLyA0IC0gUkdCQVxuICAvLyAwOiAwLCAxOiAxLCAyOiAyLCAzOiAzXG4gIGZ1bmN0aW9uIChweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpIHtcbiAgICBpZiAocmF3UG9zICsgMyA+PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiUmFuIG91dCBvZiBkYXRhXCIpO1xuICAgIH1cblxuICAgIHB4RGF0YVtweFBvc10gPSBkYXRhW3Jhd1Bvc107XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBkYXRhW3Jhd1BvcyArIDFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gZGF0YVtyYXdQb3MgKyAyXTtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IGRhdGFbcmF3UG9zICsgM107XG4gIH0sXG5dO1xuXG5sZXQgcGl4ZWxCcHBDdXN0b21NYXBwZXIgPSBbXG4gIC8vIDAgLSBkdW1teSBlbnRyeVxuICBmdW5jdGlvbiAoKSB7fSxcblxuICAvLyAxIC0gTFxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAweGZmXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MsIG1heEJpdCkge1xuICAgIGxldCBwaXhlbCA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gbWF4Qml0O1xuICB9LFxuXG4gIC8vIDIgLSBMQVxuICAvLyAwOiAwLCAxOiAwLCAyOiAwLCAzOiAxXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MpIHtcbiAgICBsZXQgcGl4ZWwgPSBwaXhlbERhdGFbMF07XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IHBpeGVsRGF0YVsxXTtcbiAgfSxcblxuICAvLyAzIC0gUkdCXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KSB7XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsRGF0YVsxXTtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsRGF0YVsyXTtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IG1heEJpdDtcbiAgfSxcblxuICAvLyA0IC0gUkdCQVxuICAvLyAwOiAwLCAxOiAxLCAyOiAyLCAzOiAzXG4gIGZ1bmN0aW9uIChweERhdGEsIHBpeGVsRGF0YSwgcHhQb3MpIHtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWxEYXRhWzFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWxEYXRhWzJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gcGl4ZWxEYXRhWzNdO1xuICB9LFxuXTtcblxuZnVuY3Rpb24gYml0UmV0cmlldmVyKGRhdGEsIGRlcHRoKSB7XG4gIGxldCBsZWZ0T3ZlciA9IFtdO1xuICBsZXQgaSA9IDA7XG5cbiAgZnVuY3Rpb24gc3BsaXQoKSB7XG4gICAgaWYgKGkgPT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuICAgIGxldCBieXRlID0gZGF0YVtpXTtcbiAgICBpKys7XG4gICAgbGV0IGJ5dGU4LCBieXRlNywgYnl0ZTYsIGJ5dGU1LCBieXRlNCwgYnl0ZTMsIGJ5dGUyLCBieXRlMTtcbiAgICBzd2l0Y2ggKGRlcHRoKSB7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgZGVwdGhcIik7XG4gICAgICBjYXNlIDE2OlxuICAgICAgICBieXRlMiA9IGRhdGFbaV07XG4gICAgICAgIGkrKztcbiAgICAgICAgbGVmdE92ZXIucHVzaCgoYnl0ZSA8PCA4KSArIGJ5dGUyKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDQ6XG4gICAgICAgIGJ5dGUyID0gYnl0ZSAmIDB4MGY7XG4gICAgICAgIGJ5dGUxID0gYnl0ZSA+PiA0O1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMik7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAyOlxuICAgICAgICBieXRlNCA9IGJ5dGUgJiAzO1xuICAgICAgICBieXRlMyA9IChieXRlID4+IDIpICYgMztcbiAgICAgICAgYnl0ZTIgPSAoYnl0ZSA+PiA0KSAmIDM7XG4gICAgICAgIGJ5dGUxID0gKGJ5dGUgPj4gNikgJiAzO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMiwgYnl0ZTMsIGJ5dGU0KTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDE6XG4gICAgICAgIGJ5dGU4ID0gYnl0ZSAmIDE7XG4gICAgICAgIGJ5dGU3ID0gKGJ5dGUgPj4gMSkgJiAxO1xuICAgICAgICBieXRlNiA9IChieXRlID4+IDIpICYgMTtcbiAgICAgICAgYnl0ZTUgPSAoYnl0ZSA+PiAzKSAmIDE7XG4gICAgICAgIGJ5dGU0ID0gKGJ5dGUgPj4gNCkgJiAxO1xuICAgICAgICBieXRlMyA9IChieXRlID4+IDUpICYgMTtcbiAgICAgICAgYnl0ZTIgPSAoYnl0ZSA+PiA2KSAmIDE7XG4gICAgICAgIGJ5dGUxID0gKGJ5dGUgPj4gNykgJiAxO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKGJ5dGUxLCBieXRlMiwgYnl0ZTMsIGJ5dGU0LCBieXRlNSwgYnl0ZTYsIGJ5dGU3LCBieXRlOCk7XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7XG4gICAgZ2V0OiBmdW5jdGlvbiAoY291bnQpIHtcbiAgICAgIHdoaWxlIChsZWZ0T3Zlci5sZW5ndGggPCBjb3VudCkge1xuICAgICAgICBzcGxpdCgpO1xuICAgICAgfVxuICAgICAgbGV0IHJldHVybmVyID0gbGVmdE92ZXIuc2xpY2UoMCwgY291bnQpO1xuICAgICAgbGVmdE92ZXIgPSBsZWZ0T3Zlci5zbGljZShjb3VudCk7XG4gICAgICByZXR1cm4gcmV0dXJuZXI7XG4gICAgfSxcbiAgICByZXNldEFmdGVyTGluZTogZnVuY3Rpb24gKCkge1xuICAgICAgbGVmdE92ZXIubGVuZ3RoID0gMDtcbiAgICB9LFxuICAgIGVuZDogZnVuY3Rpb24gKCkge1xuICAgICAgaWYgKGkgIT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcImV4dHJhIGRhdGEgZm91bmRcIik7XG4gICAgICB9XG4gICAgfSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbWFwSW1hZ2U4Qml0KGltYWdlLCBweERhdGEsIGdldFB4UG9zLCBicHAsIGRhdGEsIHJhd1Bvcykge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgbGV0IGltYWdlV2lkdGggPSBpbWFnZS53aWR0aDtcbiAgbGV0IGltYWdlSGVpZ2h0ID0gaW1hZ2UuaGVpZ2h0O1xuICBsZXQgaW1hZ2VQYXNzID0gaW1hZ2UuaW5kZXg7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaW1hZ2VIZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgaW1hZ2VXaWR0aDsgeCsrKSB7XG4gICAgICBsZXQgcHhQb3MgPSBnZXRQeFBvcyh4LCB5LCBpbWFnZVBhc3MpO1xuICAgICAgcGl4ZWxCcHBNYXBwZXJbYnBwXShweERhdGEsIGRhdGEsIHB4UG9zLCByYXdQb3MpO1xuICAgICAgcmF3UG9zICs9IGJwcDsgLy9lc2xpbnQtZGlzYWJsZS1saW5lIG5vLXBhcmFtLXJlYXNzaWduXG4gICAgfVxuICB9XG4gIHJldHVybiByYXdQb3M7XG59XG5cbmZ1bmN0aW9uIG1hcEltYWdlQ3VzdG9tQml0KGltYWdlLCBweERhdGEsIGdldFB4UG9zLCBicHAsIGJpdHMsIG1heEJpdCkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgbGV0IGltYWdlV2lkdGggPSBpbWFnZS53aWR0aDtcbiAgbGV0IGltYWdlSGVpZ2h0ID0gaW1hZ2UuaGVpZ2h0O1xuICBsZXQgaW1hZ2VQYXNzID0gaW1hZ2UuaW5kZXg7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaW1hZ2VIZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgaW1hZ2VXaWR0aDsgeCsrKSB7XG4gICAgICBsZXQgcGl4ZWxEYXRhID0gYml0cy5nZXQoYnBwKTtcbiAgICAgIGxldCBweFBvcyA9IGdldFB4UG9zKHgsIHksIGltYWdlUGFzcyk7XG4gICAgICBwaXhlbEJwcEN1c3RvbU1hcHBlclticHBdKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KTtcbiAgICB9XG4gICAgYml0cy5yZXNldEFmdGVyTGluZSgpO1xuICB9XG59XG5cbmV4cG9ydHMuZGF0YVRvQml0TWFwID0gZnVuY3Rpb24gKGRhdGEsIGJpdG1hcEluZm8pIHtcbiAgbGV0IHdpZHRoID0gYml0bWFwSW5mby53aWR0aDtcbiAgbGV0IGhlaWdodCA9IGJpdG1hcEluZm8uaGVpZ2h0O1xuICBsZXQgZGVwdGggPSBiaXRtYXBJbmZvLmRlcHRoO1xuICBsZXQgYnBwID0gYml0bWFwSW5mby5icHA7XG4gIGxldCBpbnRlcmxhY2UgPSBiaXRtYXBJbmZvLmludGVybGFjZTtcbiAgbGV0IGJpdHM7XG5cbiAgaWYgKGRlcHRoICE9PSA4KSB7XG4gICAgYml0cyA9IGJpdFJldHJpZXZlcihkYXRhLCBkZXB0aCk7XG4gIH1cbiAgbGV0IHB4RGF0YTtcbiAgaWYgKGRlcHRoIDw9IDgpIHtcbiAgICBweERhdGEgPSBCdWZmZXIuYWxsb2Mod2lkdGggKiBoZWlnaHQgKiA0KTtcbiAgfSBlbHNlIHtcbiAgICBweERhdGEgPSBuZXcgVWludDE2QXJyYXkod2lkdGggKiBoZWlnaHQgKiA0KTtcbiAgfVxuICBsZXQgbWF4Qml0ID0gTWF0aC5wb3coMiwgZGVwdGgpIC0gMTtcbiAgbGV0IHJhd1BvcyA9IDA7XG4gIGxldCBpbWFnZXM7XG4gIGxldCBnZXRQeFBvcztcblxuICBpZiAoaW50ZXJsYWNlKSB7XG4gICAgaW1hZ2VzID0gaW50ZXJsYWNlVXRpbHMuZ2V0SW1hZ2VQYXNzZXMod2lkdGgsIGhlaWdodCk7XG4gICAgZ2V0UHhQb3MgPSBpbnRlcmxhY2VVdGlscy5nZXRJbnRlcmxhY2VJdGVyYXRvcih3aWR0aCwgaGVpZ2h0KTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgbm9uSW50ZXJsYWNlZFB4UG9zID0gMDtcbiAgICBnZXRQeFBvcyA9IGZ1bmN0aW9uICgpIHtcbiAgICAgIGxldCByZXR1cm5lciA9IG5vbkludGVybGFjZWRQeFBvcztcbiAgICAgIG5vbkludGVybGFjZWRQeFBvcyArPSA0O1xuICAgICAgcmV0dXJuIHJldHVybmVyO1xuICAgIH07XG4gICAgaW1hZ2VzID0gW3sgd2lkdGg6IHdpZHRoLCBoZWlnaHQ6IGhlaWdodCB9XTtcbiAgfVxuXG4gIGZvciAobGV0IGltYWdlSW5kZXggPSAwOyBpbWFnZUluZGV4IDwgaW1hZ2VzLmxlbmd0aDsgaW1hZ2VJbmRleCsrKSB7XG4gICAgaWYgKGRlcHRoID09PSA4KSB7XG4gICAgICByYXdQb3MgPSBtYXBJbWFnZThCaXQoXG4gICAgICAgIGltYWdlc1tpbWFnZUluZGV4XSxcbiAgICAgICAgcHhEYXRhLFxuICAgICAgICBnZXRQeFBvcyxcbiAgICAgICAgYnBwLFxuICAgICAgICBkYXRhLFxuICAgICAgICByYXdQb3NcbiAgICAgICk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1hcEltYWdlQ3VzdG9tQml0KFxuICAgICAgICBpbWFnZXNbaW1hZ2VJbmRleF0sXG4gICAgICAgIHB4RGF0YSxcbiAgICAgICAgZ2V0UHhQb3MsXG4gICAgICAgIGJwcCxcbiAgICAgICAgYml0cyxcbiAgICAgICAgbWF4Qml0XG4gICAgICApO1xuICAgIH1cbiAgfVxuICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICBpZiAocmF3UG9zICE9PSBkYXRhLmxlbmd0aCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZXh0cmEgZGF0YSBmb3VuZFwiKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgYml0cy5lbmQoKTtcbiAgfVxuXG4gIHJldHVybiBweERhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5mdW5jdGlvbiBkZVBhbGV0dGUoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCBwYWxldHRlKSB7XG4gIGxldCBweFBvcyA9IDA7XG4gIC8vIHVzZSB2YWx1ZXMgZnJvbSBwYWxldHRlXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBjb2xvciA9IHBhbGV0dGVbaW5kYXRhW3B4UG9zXV07XG5cbiAgICAgIGlmICghY29sb3IpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiaW5kZXggXCIgKyBpbmRhdGFbcHhQb3NdICsgXCIgbm90IGluIHBhbGV0dGVcIik7XG4gICAgICB9XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgICAgIG91dGRhdGFbcHhQb3MgKyBpXSA9IGNvbG9yW2ldO1xuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVwbGFjZVRyYW5zcGFyZW50Q29sb3IoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0cmFuc0NvbG9yKSB7XG4gIGxldCBweFBvcyA9IDA7XG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBtYWtlVHJhbnMgPSBmYWxzZTtcblxuICAgICAgaWYgKHRyYW5zQ29sb3IubGVuZ3RoID09PSAxKSB7XG4gICAgICAgIGlmICh0cmFuc0NvbG9yWzBdID09PSBpbmRhdGFbcHhQb3NdKSB7XG4gICAgICAgICAgbWFrZVRyYW5zID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChcbiAgICAgICAgdHJhbnNDb2xvclswXSA9PT0gaW5kYXRhW3B4UG9zXSAmJlxuICAgICAgICB0cmFuc0NvbG9yWzFdID09PSBpbmRhdGFbcHhQb3MgKyAxXSAmJlxuICAgICAgICB0cmFuc0NvbG9yWzJdID09PSBpbmRhdGFbcHhQb3MgKyAyXVxuICAgICAgKSB7XG4gICAgICAgIG1ha2VUcmFucyA9IHRydWU7XG4gICAgICB9XG4gICAgICBpZiAobWFrZVRyYW5zKSB7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgNDsgaSsrKSB7XG4gICAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gMDtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gc2NhbGVEZXB0aChpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIGRlcHRoKSB7XG4gIGxldCBtYXhPdXRTYW1wbGUgPSAyNTU7XG4gIGxldCBtYXhJblNhbXBsZSA9IE1hdGgucG93KDIsIGRlcHRoKSAtIDE7XG4gIGxldCBweFBvcyA9IDA7XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gTWF0aC5mbG9vcihcbiAgICAgICAgICAoaW5kYXRhW3B4UG9zICsgaV0gKiBtYXhPdXRTYW1wbGUpIC8gbWF4SW5TYW1wbGUgKyAwLjVcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHB4UG9zICs9IDQ7XG4gICAgfVxuICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGluZGF0YSwgaW1hZ2VEYXRhLCBza2lwUmVzY2FsZSA9IGZhbHNlKSB7XG4gIGxldCBkZXB0aCA9IGltYWdlRGF0YS5kZXB0aDtcbiAgbGV0IHdpZHRoID0gaW1hZ2VEYXRhLndpZHRoO1xuICBsZXQgaGVpZ2h0ID0gaW1hZ2VEYXRhLmhlaWdodDtcbiAgbGV0IGNvbG9yVHlwZSA9IGltYWdlRGF0YS5jb2xvclR5cGU7XG4gIGxldCB0cmFuc0NvbG9yID0gaW1hZ2VEYXRhLnRyYW5zQ29sb3I7XG4gIGxldCBwYWxldHRlID0gaW1hZ2VEYXRhLnBhbGV0dGU7XG5cbiAgbGV0IG91dGRhdGEgPSBpbmRhdGE7IC8vIG9ubHkgZGlmZmVyZW50IGZvciAxNiBiaXRzXG5cbiAgaWYgKGNvbG9yVHlwZSA9PT0gMykge1xuICAgIC8vIHBhbGV0dGVkXG4gICAgZGVQYWxldHRlKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgcGFsZXR0ZSk7XG4gIH0gZWxzZSB7XG4gICAgaWYgKHRyYW5zQ29sb3IpIHtcbiAgICAgIHJlcGxhY2VUcmFuc3BhcmVudENvbG9yKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgdHJhbnNDb2xvcik7XG4gICAgfVxuICAgIC8vIGlmIGl0IG5lZWRzIHNjYWxpbmdcbiAgICBpZiAoZGVwdGggIT09IDggJiYgIXNraXBSZXNjYWxlKSB7XG4gICAgICAvLyBpZiB3ZSBuZWVkIHRvIGNoYW5nZSB0aGUgYnVmZmVyIHNpemVcbiAgICAgIGlmIChkZXB0aCA9PT0gMTYpIHtcbiAgICAgICAgb3V0ZGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICAgICAgfVxuICAgICAgc2NhbGVEZXB0aChpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIGRlcHRoKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIG91dGRhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCBDaHVua1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NodW5rc3RyZWFtXCIpO1xubGV0IEZpbHRlckFzeW5jID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlLWFzeW5jXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlclwiKTtcbmxldCBiaXRtYXBwZXIgPSByZXF1aXJlKFwiLi9iaXRtYXBwZXJcIik7XG5sZXQgZm9ybWF0Tm9ybWFsaXNlciA9IHJlcXVpcmUoXCIuL2Zvcm1hdC1ub3JtYWxpc2VyXCIpO1xuXG5sZXQgUGFyc2VyQXN5bmMgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucykge1xuICBDaHVua1N0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIHRoaXMuX3BhcnNlciA9IG5ldyBQYXJzZXIob3B0aW9ucywge1xuICAgIHJlYWQ6IHRoaXMucmVhZC5iaW5kKHRoaXMpLFxuICAgIGVycm9yOiB0aGlzLl9oYW5kbGVFcnJvci5iaW5kKHRoaXMpLFxuICAgIG1ldGFkYXRhOiB0aGlzLl9oYW5kbGVNZXRhRGF0YS5iaW5kKHRoaXMpLFxuICAgIGdhbW1hOiB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImdhbW1hXCIpLFxuICAgIHBhbGV0dGU6IHRoaXMuX2hhbmRsZVBhbGV0dGUuYmluZCh0aGlzKSxcbiAgICB0cmFuc0NvbG9yOiB0aGlzLl9oYW5kbGVUcmFuc0NvbG9yLmJpbmQodGhpcyksXG4gICAgZmluaXNoZWQ6IHRoaXMuX2ZpbmlzaGVkLmJpbmQodGhpcyksXG4gICAgaW5mbGF0ZURhdGE6IHRoaXMuX2luZmxhdGVEYXRhLmJpbmQodGhpcyksXG4gICAgc2ltcGxlVHJhbnNwYXJlbmN5OiB0aGlzLl9zaW1wbGVUcmFuc3BhcmVuY3kuYmluZCh0aGlzKSxcbiAgICBoZWFkZXJzRmluaXNoZWQ6IHRoaXMuX2hlYWRlcnNGaW5pc2hlZC5iaW5kKHRoaXMpLFxuICB9KTtcbiAgdGhpcy5fb3B0aW9ucyA9IG9wdGlvbnM7XG4gIHRoaXMud3JpdGFibGUgPSB0cnVlO1xuXG4gIHRoaXMuX3BhcnNlci5zdGFydCgpO1xufSk7XG51dGlsLmluaGVyaXRzKFBhcnNlckFzeW5jLCBDaHVua1N0cmVhbSk7XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gIHRoaXMuZW1pdChcImVycm9yXCIsIGVycik7XG5cbiAgdGhpcy53cml0YWJsZSA9IGZhbHNlO1xuXG4gIHRoaXMuZGVzdHJveSgpO1xuXG4gIGlmICh0aGlzLl9pbmZsYXRlICYmIHRoaXMuX2luZmxhdGUuZGVzdHJveSkge1xuICAgIHRoaXMuX2luZmxhdGUuZGVzdHJveSgpO1xuICB9XG5cbiAgaWYgKHRoaXMuX2ZpbHRlcikge1xuICAgIHRoaXMuX2ZpbHRlci5kZXN0cm95KCk7XG4gICAgLy8gRm9yIGJhY2t3YXJkIGNvbXBhdGliaWxpdHkgd2l0aCBOb2RlIDcgYW5kIGJlbG93LlxuICAgIC8vIFN1cHByZXNzIGVycm9ycyBkdWUgdG8gX2luZmxhdGUgY2FsbGluZyB3cml0ZSgpIGV2ZW4gYWZ0ZXJcbiAgICAvLyBpdCdzIGRlc3Ryb3koKSdlZC5cbiAgICB0aGlzLl9maWx0ZXIub24oXCJlcnJvclwiLCBmdW5jdGlvbiAoKSB7fSk7XG4gIH1cblxuICB0aGlzLmVycm9yZCA9IHRydWU7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2luZmxhdGVEYXRhID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgaWYgKCF0aGlzLl9pbmZsYXRlKSB7XG4gICAgaWYgKHRoaXMuX2JpdG1hcEluZm8uaW50ZXJsYWNlKSB7XG4gICAgICB0aGlzLl9pbmZsYXRlID0gemxpYi5jcmVhdGVJbmZsYXRlKCk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbiAgICAgIHRoaXMuX2ZpbHRlci5vbihcImNvbXBsZXRlXCIsIHRoaXMuX2NvbXBsZXRlLmJpbmQodGhpcykpO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlLnBpcGUodGhpcy5fZmlsdGVyKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGV0IHJvd1NpemUgPVxuICAgICAgICAoKHRoaXMuX2JpdG1hcEluZm8ud2lkdGggKlxuICAgICAgICAgIHRoaXMuX2JpdG1hcEluZm8uYnBwICpcbiAgICAgICAgICB0aGlzLl9iaXRtYXBJbmZvLmRlcHRoICtcbiAgICAgICAgICA3KSA+PlxuICAgICAgICAgIDMpICtcbiAgICAgICAgMTtcbiAgICAgIGxldCBpbWFnZVNpemUgPSByb3dTaXplICogdGhpcy5fYml0bWFwSW5mby5oZWlnaHQ7XG4gICAgICBsZXQgY2h1bmtTaXplID0gTWF0aC5tYXgoaW1hZ2VTaXplLCB6bGliLlpfTUlOX0NIVU5LKTtcblxuICAgICAgdGhpcy5faW5mbGF0ZSA9IHpsaWIuY3JlYXRlSW5mbGF0ZSh7IGNodW5rU2l6ZTogY2h1bmtTaXplIH0pO1xuICAgICAgbGV0IGxlZnRUb0luZmxhdGUgPSBpbWFnZVNpemU7XG5cbiAgICAgIGxldCBlbWl0RXJyb3IgPSB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpO1xuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImVycm9yXCIsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICAgICAgaWYgKCFsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgZW1pdEVycm9yKGVycik7XG4gICAgICB9KTtcbiAgICAgIHRoaXMuX2ZpbHRlci5vbihcImNvbXBsZXRlXCIsIHRoaXMuX2NvbXBsZXRlLmJpbmQodGhpcykpO1xuXG4gICAgICBsZXQgZmlsdGVyV3JpdGUgPSB0aGlzLl9maWx0ZXIud3JpdGUuYmluZCh0aGlzLl9maWx0ZXIpO1xuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImRhdGFcIiwgZnVuY3Rpb24gKGNodW5rKSB7XG4gICAgICAgIGlmICghbGVmdFRvSW5mbGF0ZSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjaHVuay5sZW5ndGggPiBsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgY2h1bmsgPSBjaHVuay5zbGljZSgwLCBsZWZ0VG9JbmZsYXRlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxlZnRUb0luZmxhdGUgLT0gY2h1bmsubGVuZ3RoO1xuXG4gICAgICAgIGZpbHRlcldyaXRlKGNodW5rKTtcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZW5kXCIsIHRoaXMuX2ZpbHRlci5lbmQuYmluZCh0aGlzLl9maWx0ZXIpKTtcbiAgICB9XG4gIH1cbiAgdGhpcy5faW5mbGF0ZS53cml0ZShkYXRhKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlTWV0YURhdGEgPSBmdW5jdGlvbiAobWV0YURhdGEpIHtcbiAgdGhpcy5fbWV0YURhdGEgPSBtZXRhRGF0YTtcbiAgdGhpcy5fYml0bWFwSW5mbyA9IE9iamVjdC5jcmVhdGUobWV0YURhdGEpO1xuXG4gIHRoaXMuX2ZpbHRlciA9IG5ldyBGaWx0ZXJBc3luYyh0aGlzLl9iaXRtYXBJbmZvKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlVHJhbnNDb2xvciA9IGZ1bmN0aW9uICh0cmFuc0NvbG9yKSB7XG4gIHRoaXMuX2JpdG1hcEluZm8udHJhbnNDb2xvciA9IHRyYW5zQ29sb3I7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2hhbmRsZVBhbGV0dGUgPSBmdW5jdGlvbiAocGFsZXR0ZSkge1xuICB0aGlzLl9iaXRtYXBJbmZvLnBhbGV0dGUgPSBwYWxldHRlO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9zaW1wbGVUcmFuc3BhcmVuY3kgPSBmdW5jdGlvbiAoKSB7XG4gIHRoaXMuX21ldGFEYXRhLmFscGhhID0gdHJ1ZTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGVhZGVyc0ZpbmlzaGVkID0gZnVuY3Rpb24gKCkge1xuICAvLyBVcCB1bnRpbCB0aGlzIHBvaW50LCB3ZSBkb24ndCBrbm93IGlmIHdlIGhhdmUgYSB0Uk5TIGNodW5rIChhbHBoYSlcbiAgLy8gc28gd2UgY2FuJ3QgZW1pdCBtZXRhZGF0YSBhbnkgZWFybGllclxuICB0aGlzLmVtaXQoXCJtZXRhZGF0YVwiLCB0aGlzLl9tZXRhRGF0YSk7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2ZpbmlzaGVkID0gZnVuY3Rpb24gKCkge1xuICBpZiAodGhpcy5lcnJvcmQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoIXRoaXMuX2luZmxhdGUpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBcIk5vIEluZmxhdGUgYmxvY2tcIik7XG4gIH0gZWxzZSB7XG4gICAgLy8gbm8gbW9yZSBkYXRhIHRvIGluZmxhdGVcbiAgICB0aGlzLl9pbmZsYXRlLmVuZCgpO1xuICB9XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX2NvbXBsZXRlID0gZnVuY3Rpb24gKGZpbHRlcmVkRGF0YSkge1xuICBpZiAodGhpcy5lcnJvcmQpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICBsZXQgbm9ybWFsaXNlZEJpdG1hcERhdGE7XG5cbiAgdHJ5IHtcbiAgICBsZXQgYml0bWFwRGF0YSA9IGJpdG1hcHBlci5kYXRhVG9CaXRNYXAoZmlsdGVyZWREYXRhLCB0aGlzLl9iaXRtYXBJbmZvKTtcblxuICAgIG5vcm1hbGlzZWRCaXRtYXBEYXRhID0gZm9ybWF0Tm9ybWFsaXNlcihcbiAgICAgIGJpdG1hcERhdGEsXG4gICAgICB0aGlzLl9iaXRtYXBJbmZvLFxuICAgICAgdGhpcy5fb3B0aW9ucy5za2lwUmVzY2FsZVxuICAgICk7XG4gICAgYml0bWFwRGF0YSA9IG51bGw7XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhpcy5faGFuZGxlRXJyb3IoZXgpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuZW1pdChcInBhcnNlZFwiLCBub3JtYWxpc2VkQml0bWFwRGF0YSk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChkYXRhSW4sIHdpZHRoLCBoZWlnaHQsIG9wdGlvbnMpIHtcbiAgbGV0IG91dEhhc0FscGhhID1cbiAgICBbY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQSwgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQV0uaW5kZXhPZihcbiAgICAgIG9wdGlvbnMuY29sb3JUeXBlXG4gICAgKSAhPT0gLTE7XG4gIGlmIChvcHRpb25zLmNvbG9yVHlwZSA9PT0gb3B0aW9ucy5pbnB1dENvbG9yVHlwZSkge1xuICAgIGxldCBiaWdFbmRpYW4gPSAoZnVuY3Rpb24gKCkge1xuICAgICAgbGV0IGJ1ZmZlciA9IG5ldyBBcnJheUJ1ZmZlcigyKTtcbiAgICAgIG5ldyBEYXRhVmlldyhidWZmZXIpLnNldEludDE2KDAsIDI1NiwgdHJ1ZSAvKiBsaXR0bGVFbmRpYW4gKi8pO1xuICAgICAgLy8gSW50MTZBcnJheSB1c2VzIHRoZSBwbGF0Zm9ybSdzIGVuZGlhbm5lc3MuXG4gICAgICByZXR1cm4gbmV3IEludDE2QXJyYXkoYnVmZmVyKVswXSAhPT0gMjU2O1xuICAgIH0pKCk7XG4gICAgLy8gSWYgbm8gbmVlZCB0byBjb252ZXJ0IHRvIGdyYXlzY2FsZSBhbmQgYWxwaGEgaXMgcHJlc2VudC9hYnNlbnQgaW4gYm90aCwgdGFrZSBhIGZhc3Qgcm91dGVcbiAgICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gOCB8fCAob3B0aW9ucy5iaXREZXB0aCA9PT0gMTYgJiYgYmlnRW5kaWFuKSkge1xuICAgICAgcmV0dXJuIGRhdGFJbjtcbiAgICB9XG4gIH1cblxuICAvLyBtYXAgdG8gYSBVSW50MTYgYXJyYXkgaWYgZGF0YSBpcyAxNmJpdCwgZml4IGVuZGlhbm5lc3MgYmVsb3dcbiAgbGV0IGRhdGEgPSBvcHRpb25zLmJpdERlcHRoICE9PSAxNiA/IGRhdGFJbiA6IG5ldyBVaW50MTZBcnJheShkYXRhSW4uYnVmZmVyKTtcblxuICBsZXQgbWF4VmFsdWUgPSAyNTU7XG4gIGxldCBpbkJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFtvcHRpb25zLmlucHV0Q29sb3JUeXBlXTtcbiAgaWYgKGluQnBwID09PSA0ICYmICFvcHRpb25zLmlucHV0SGFzQWxwaGEpIHtcbiAgICBpbkJwcCA9IDM7XG4gIH1cbiAgbGV0IG91dEJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFtvcHRpb25zLmNvbG9yVHlwZV07XG4gIGlmIChvcHRpb25zLmJpdERlcHRoID09PSAxNikge1xuICAgIG1heFZhbHVlID0gNjU1MzU7XG4gICAgb3V0QnBwICo9IDI7XG4gIH1cbiAgbGV0IG91dERhdGEgPSBCdWZmZXIuYWxsb2Mod2lkdGggKiBoZWlnaHQgKiBvdXRCcHApO1xuXG4gIGxldCBpbkluZGV4ID0gMDtcbiAgbGV0IG91dEluZGV4ID0gMDtcblxuICBsZXQgYmdDb2xvciA9IG9wdGlvbnMuYmdDb2xvciB8fCB7fTtcbiAgaWYgKGJnQ29sb3IucmVkID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLnJlZCA9IG1heFZhbHVlO1xuICB9XG4gIGlmIChiZ0NvbG9yLmdyZWVuID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLmdyZWVuID0gbWF4VmFsdWU7XG4gIH1cbiAgaWYgKGJnQ29sb3IuYmx1ZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgYmdDb2xvci5ibHVlID0gbWF4VmFsdWU7XG4gIH1cblxuICBmdW5jdGlvbiBnZXRSR0JBKCkge1xuICAgIGxldCByZWQ7XG4gICAgbGV0IGdyZWVuO1xuICAgIGxldCBibHVlO1xuICAgIGxldCBhbHBoYSA9IG1heFZhbHVlO1xuICAgIHN3aXRjaCAob3B0aW9ucy5pbnB1dENvbG9yVHlwZSkge1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBOlxuICAgICAgICBhbHBoYSA9IGRhdGFbaW5JbmRleCArIDNdO1xuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICBibHVlID0gZGF0YVtpbkluZGV4ICsgMl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SOlxuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICBibHVlID0gZGF0YVtpbkluZGV4ICsgMl07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBOlxuICAgICAgICBhbHBoYSA9IGRhdGFbaW5JbmRleCArIDFdO1xuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IHJlZDtcbiAgICAgICAgYmx1ZSA9IHJlZDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfR1JBWVNDQUxFOlxuICAgICAgICByZWQgPSBkYXRhW2luSW5kZXhdO1xuICAgICAgICBncmVlbiA9IHJlZDtcbiAgICAgICAgYmx1ZSA9IHJlZDtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJpbnB1dCBjb2xvciB0eXBlOlwiICtcbiAgICAgICAgICAgIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgK1xuICAgICAgICAgICAgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAob3B0aW9ucy5pbnB1dEhhc0FscGhhKSB7XG4gICAgICBpZiAoIW91dEhhc0FscGhhKSB7XG4gICAgICAgIGFscGhhIC89IG1heFZhbHVlO1xuICAgICAgICByZWQgPSBNYXRoLm1pbihcbiAgICAgICAgICBNYXRoLm1heChNYXRoLnJvdW5kKCgxIC0gYWxwaGEpICogYmdDb2xvci5yZWQgKyBhbHBoYSAqIHJlZCksIDApLFxuICAgICAgICAgIG1heFZhbHVlXG4gICAgICAgICk7XG4gICAgICAgIGdyZWVuID0gTWF0aC5taW4oXG4gICAgICAgICAgTWF0aC5tYXgoTWF0aC5yb3VuZCgoMSAtIGFscGhhKSAqIGJnQ29sb3IuZ3JlZW4gKyBhbHBoYSAqIGdyZWVuKSwgMCksXG4gICAgICAgICAgbWF4VmFsdWVcbiAgICAgICAgKTtcbiAgICAgICAgYmx1ZSA9IE1hdGgubWluKFxuICAgICAgICAgIE1hdGgubWF4KE1hdGgucm91bmQoKDEgLSBhbHBoYSkgKiBiZ0NvbG9yLmJsdWUgKyBhbHBoYSAqIGJsdWUpLCAwKSxcbiAgICAgICAgICBtYXhWYWx1ZVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4geyByZWQ6IHJlZCwgZ3JlZW46IGdyZWVuLCBibHVlOiBibHVlLCBhbHBoYTogYWxwaGEgfTtcbiAgfVxuXG4gIGZvciAobGV0IHkgPSAwOyB5IDwgaGVpZ2h0OyB5KyspIHtcbiAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgIGxldCByZ2JhID0gZ2V0UkdCQShkYXRhLCBpbkluZGV4KTtcblxuICAgICAgc3dpdGNoIChvcHRpb25zLmNvbG9yVHlwZSkge1xuICAgICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE6XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUjpcbiAgICAgICAgICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gOCkge1xuICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleF0gPSByZ2JhLnJlZDtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAxXSA9IHJnYmEuZ3JlZW47XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgMl0gPSByZ2JhLmJsdWU7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleCArIDNdID0gcmdiYS5hbHBoYTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEucmVkLCBvdXRJbmRleCk7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5ncmVlbiwgb3V0SW5kZXggKyAyKTtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShyZ2JhLmJsdWUsIG91dEluZGV4ICsgNCk7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYWxwaGEsIG91dEluZGV4ICsgNik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEE6XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEU6IHtcbiAgICAgICAgICAvLyBDb252ZXJ0IHRvIGdyYXlzY2FsZSBhbmQgYWxwaGFcbiAgICAgICAgICBsZXQgZ3JheXNjYWxlID0gKHJnYmEucmVkICsgcmdiYS5ncmVlbiArIHJnYmEuYmx1ZSkgLyAzO1xuICAgICAgICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4KSB7XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4XSA9IGdyYXlzY2FsZTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgMV0gPSByZ2JhLmFscGhhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUoZ3JheXNjYWxlLCBvdXRJbmRleCk7XG4gICAgICAgICAgICBpZiAob3V0SGFzQWxwaGEpIHtcbiAgICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYWxwaGEsIG91dEluZGV4ICsgMik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwidW5yZWNvZ25pc2VkIGNvbG9yIFR5cGUgXCIgKyBvcHRpb25zLmNvbG9yVHlwZSk7XG4gICAgICB9XG5cbiAgICAgIGluSW5kZXggKz0gaW5CcHA7XG4gICAgICBvdXRJbmRleCArPSBvdXRCcHA7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG91dERhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgcGFldGhQcmVkaWN0b3IgPSByZXF1aXJlKFwiLi9wYWV0aC1wcmVkaWN0b3JcIik7XG5cbmZ1bmN0aW9uIGZpbHRlck5vbmUocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MpIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSBweERhdGFbcHhQb3MgKyB4XTtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1Ob25lKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCkge1xuICBsZXQgc3VtID0gMDtcbiAgbGV0IGxlbmd0aCA9IHB4UG9zICsgYnl0ZVdpZHRoO1xuXG4gIGZvciAobGV0IGkgPSBweFBvczsgaSA8IGxlbmd0aDsgaSsrKSB7XG4gICAgc3VtICs9IE1hdGguYWJzKHB4RGF0YVtpXSk7XG4gIH1cbiAgcmV0dXJuIHN1bTtcbn1cblxuZnVuY3Rpb24gZmlsdGVyU3ViKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gbGVmdDtcblxuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSB2YWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmlsdGVyU3VtU3ViKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBsZWZ0O1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJVcChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1Bvcykge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIHVwO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1VcChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgpIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGxldCBsZW5ndGggPSBweFBvcyArIGJ5dGVXaWR0aDtcbiAgZm9yIChsZXQgeCA9IHB4UG9zOyB4IDwgbGVuZ3RoOyB4KyspIHtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbeF0gLSB1cDtcblxuICAgIHN1bSArPSBNYXRoLmFicyh2YWwpO1xuICB9XG5cbiAgcmV0dXJuIHN1bTtcbn1cblxuZnVuY3Rpb24gZmlsdGVyQXZnKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtICgobGVmdCArIHVwKSA+PiAxKTtcblxuICAgIHJhd0RhdGFbcmF3UG9zICsgeF0gPSB2YWw7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmlsdGVyU3VtQXZnKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gKChsZWZ0ICsgdXApID4+IDEpO1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJQYWV0aChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1BvcywgYnBwKSB7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVtweFBvcyArIHggLSBieXRlV2lkdGhdIDogMDtcbiAgICBsZXQgdXBsZWZ0ID1cbiAgICAgIHB4UG9zID4gMCAmJiB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSAoYnl0ZVdpZHRoICsgYnBwKV0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIHBhZXRoUHJlZGljdG9yKGxlZnQsIHVwLCB1cGxlZnQpO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1QYWV0aChweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIGJwcCkge1xuICBsZXQgc3VtID0gMDtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB1cGxlZnQgPVxuICAgICAgcHhQb3MgPiAwICYmIHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIChieXRlV2lkdGggKyBicHApXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gcGFldGhQcmVkaWN0b3IobGVmdCwgdXAsIHVwbGVmdCk7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmxldCBmaWx0ZXJzID0ge1xuICAwOiBmaWx0ZXJOb25lLFxuICAxOiBmaWx0ZXJTdWIsXG4gIDI6IGZpbHRlclVwLFxuICAzOiBmaWx0ZXJBdmcsXG4gIDQ6IGZpbHRlclBhZXRoLFxufTtcblxubGV0IGZpbHRlclN1bXMgPSB7XG4gIDA6IGZpbHRlclN1bU5vbmUsXG4gIDE6IGZpbHRlclN1bVN1YixcbiAgMjogZmlsdGVyU3VtVXAsXG4gIDM6IGZpbHRlclN1bUF2ZyxcbiAgNDogZmlsdGVyU3VtUGFldGgsXG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChweERhdGEsIHdpZHRoLCBoZWlnaHQsIG9wdGlvbnMsIGJwcCkge1xuICBsZXQgZmlsdGVyVHlwZXM7XG4gIGlmICghKFwiZmlsdGVyVHlwZVwiIGluIG9wdGlvbnMpIHx8IG9wdGlvbnMuZmlsdGVyVHlwZSA9PT0gLTEpIHtcbiAgICBmaWx0ZXJUeXBlcyA9IFswLCAxLCAyLCAzLCA0XTtcbiAgfSBlbHNlIGlmICh0eXBlb2Ygb3B0aW9ucy5maWx0ZXJUeXBlID09PSBcIm51bWJlclwiKSB7XG4gICAgZmlsdGVyVHlwZXMgPSBbb3B0aW9ucy5maWx0ZXJUeXBlXTtcbiAgfSBlbHNlIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgZmlsdGVyIHR5cGVzXCIpO1xuICB9XG5cbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDE2KSB7XG4gICAgYnBwICo9IDI7XG4gIH1cbiAgbGV0IGJ5dGVXaWR0aCA9IHdpZHRoICogYnBwO1xuICBsZXQgcmF3UG9zID0gMDtcbiAgbGV0IHB4UG9zID0gMDtcbiAgbGV0IHJhd0RhdGEgPSBCdWZmZXIuYWxsb2MoKGJ5dGVXaWR0aCArIDEpICogaGVpZ2h0KTtcblxuICBsZXQgc2VsID0gZmlsdGVyVHlwZXNbMF07XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGlmIChmaWx0ZXJUeXBlcy5sZW5ndGggPiAxKSB7XG4gICAgICAvLyBmaW5kIGJlc3QgZmlsdGVyIGZvciB0aGlzIGxpbmUgKHdpdGggbG93ZXN0IHN1bSBvZiB2YWx1ZXMpXG4gICAgICBsZXQgbWluID0gSW5maW5pdHk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgZmlsdGVyVHlwZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgICAgbGV0IHN1bSA9IGZpbHRlclN1bXNbZmlsdGVyVHlwZXNbaV1dKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKTtcbiAgICAgICAgaWYgKHN1bSA8IG1pbikge1xuICAgICAgICAgIHNlbCA9IGZpbHRlclR5cGVzW2ldO1xuICAgICAgICAgIG1pbiA9IHN1bTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJhd0RhdGFbcmF3UG9zXSA9IHNlbDtcbiAgICByYXdQb3MrKztcbiAgICBmaWx0ZXJzW3NlbF0ocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCk7XG4gICAgcmF3UG9zICs9IGJ5dGVXaWR0aDtcbiAgICBweFBvcyArPSBieXRlV2lkdGg7XG4gIH1cbiAgcmV0dXJuIHJhd0RhdGE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IENyY1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NyY1wiKTtcbmxldCBiaXRQYWNrZXIgPSByZXF1aXJlKFwiLi9iaXRwYWNrZXJcIik7XG5sZXQgZmlsdGVyID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhY2tcIik7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xuXG5sZXQgUGFja2VyID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgdGhpcy5fb3B0aW9ucyA9IG9wdGlvbnM7XG5cbiAgb3B0aW9ucy5kZWZsYXRlQ2h1bmtTaXplID0gb3B0aW9ucy5kZWZsYXRlQ2h1bmtTaXplIHx8IDMyICogMTAyNDtcbiAgb3B0aW9ucy5kZWZsYXRlTGV2ZWwgPVxuICAgIG9wdGlvbnMuZGVmbGF0ZUxldmVsICE9IG51bGwgPyBvcHRpb25zLmRlZmxhdGVMZXZlbCA6IDk7XG4gIG9wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5ID1cbiAgICBvcHRpb25zLmRlZmxhdGVTdHJhdGVneSAhPSBudWxsID8gb3B0aW9ucy5kZWZsYXRlU3RyYXRlZ3kgOiAzO1xuICBvcHRpb25zLmlucHV0SGFzQWxwaGEgPVxuICAgIG9wdGlvbnMuaW5wdXRIYXNBbHBoYSAhPSBudWxsID8gb3B0aW9ucy5pbnB1dEhhc0FscGhhIDogdHJ1ZTtcbiAgb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSA9IG9wdGlvbnMuZGVmbGF0ZUZhY3RvcnkgfHwgemxpYi5jcmVhdGVEZWZsYXRlO1xuICBvcHRpb25zLmJpdERlcHRoID0gb3B0aW9ucy5iaXREZXB0aCB8fCA4O1xuICAvLyBUaGlzIGlzIG91dHB1dENvbG9yVHlwZVxuICBvcHRpb25zLmNvbG9yVHlwZSA9XG4gICAgdHlwZW9mIG9wdGlvbnMuY29sb3JUeXBlID09PSBcIm51bWJlclwiXG4gICAgICA/IG9wdGlvbnMuY29sb3JUeXBlXG4gICAgICA6IGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE7XG4gIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgPVxuICAgIHR5cGVvZiBvcHRpb25zLmlucHV0Q29sb3JUeXBlID09PSBcIm51bWJlclwiXG4gICAgICA/IG9wdGlvbnMuaW5wdXRDb2xvclR5cGVcbiAgICAgIDogY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTtcblxuICBpZiAoXG4gICAgW1xuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEUsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEEsXG4gICAgXS5pbmRleE9mKG9wdGlvbnMuY29sb3JUeXBlKSA9PT0gLTFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gY29sb3IgdHlwZTpcIiArIG9wdGlvbnMuY29sb3JUeXBlICsgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG4gIGlmIChcbiAgICBbXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSxcbiAgICBdLmluZGV4T2Yob3B0aW9ucy5pbnB1dENvbG9yVHlwZSkgPT09IC0xXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwib3B0aW9uIGlucHV0IGNvbG9yIHR5cGU6XCIgK1xuICAgICAgICBvcHRpb25zLmlucHV0Q29sb3JUeXBlICtcbiAgICAgICAgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG4gIGlmIChvcHRpb25zLmJpdERlcHRoICE9PSA4ICYmIG9wdGlvbnMuYml0RGVwdGggIT09IDE2KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gYml0IGRlcHRoOlwiICsgb3B0aW9ucy5iaXREZXB0aCArIFwiIGlzIG5vdCBzdXBwb3J0ZWQgYXQgcHJlc2VudFwiXG4gICAgKTtcbiAgfVxufSk7XG5cblBhY2tlci5wcm90b3R5cGUuZ2V0RGVmbGF0ZU9wdGlvbnMgPSBmdW5jdGlvbiAoKSB7XG4gIHJldHVybiB7XG4gICAgY2h1bmtTaXplOiB0aGlzLl9vcHRpb25zLmRlZmxhdGVDaHVua1NpemUsXG4gICAgbGV2ZWw6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZUxldmVsLFxuICAgIHN0cmF0ZWd5OiB0aGlzLl9vcHRpb25zLmRlZmxhdGVTdHJhdGVneSxcbiAgfTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuY3JlYXRlRGVmbGF0ZSA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX29wdGlvbnMuZGVmbGF0ZUZhY3RvcnkodGhpcy5nZXREZWZsYXRlT3B0aW9ucygpKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuZmlsdGVyRGF0YSA9IGZ1bmN0aW9uIChkYXRhLCB3aWR0aCwgaGVpZ2h0KSB7XG4gIC8vIGNvbnZlcnQgdG8gY29ycmVjdCBmb3JtYXQgZm9yIGZpbHRlcmluZyAoZS5nLiByaWdodCBicHAgYW5kIGJpdCBkZXB0aClcbiAgbGV0IHBhY2tlZERhdGEgPSBiaXRQYWNrZXIoZGF0YSwgd2lkdGgsIGhlaWdodCwgdGhpcy5fb3B0aW9ucyk7XG5cbiAgLy8gZmlsdGVyIHBpeGVsIGRhdGFcbiAgbGV0IGJwcCA9IGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUFt0aGlzLl9vcHRpb25zLmNvbG9yVHlwZV07XG4gIGxldCBmaWx0ZXJlZERhdGEgPSBmaWx0ZXIocGFja2VkRGF0YSwgd2lkdGgsIGhlaWdodCwgdGhpcy5fb3B0aW9ucywgYnBwKTtcbiAgcmV0dXJuIGZpbHRlcmVkRGF0YTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUuX3BhY2tDaHVuayA9IGZ1bmN0aW9uICh0eXBlLCBkYXRhKSB7XG4gIGxldCBsZW4gPSBkYXRhID8gZGF0YS5sZW5ndGggOiAwO1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKGxlbiArIDEyKTtcblxuICBidWYud3JpdGVVSW50MzJCRShsZW4sIDApO1xuICBidWYud3JpdGVVSW50MzJCRSh0eXBlLCA0KTtcblxuICBpZiAoZGF0YSkge1xuICAgIGRhdGEuY29weShidWYsIDgpO1xuICB9XG5cbiAgYnVmLndyaXRlSW50MzJCRShcbiAgICBDcmNTdHJlYW0uY3JjMzIoYnVmLnNsaWNlKDQsIGJ1Zi5sZW5ndGggLSA0KSksXG4gICAgYnVmLmxlbmd0aCAtIDRcbiAgKTtcbiAgcmV0dXJuIGJ1Zjtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0dBTUEgPSBmdW5jdGlvbiAoZ2FtbWEpIHtcbiAgbGV0IGJ1ZiA9IEJ1ZmZlci5hbGxvYyg0KTtcbiAgYnVmLndyaXRlVUludDMyQkUoTWF0aC5mbG9vcihnYW1tYSAqIGNvbnN0YW50cy5HQU1NQV9ESVZJU0lPTiksIDApO1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX2dBTUEsIGJ1Zik7XG59O1xuXG5QYWNrZXIucHJvdG90eXBlLnBhY2tJSERSID0gZnVuY3Rpb24gKHdpZHRoLCBoZWlnaHQpIHtcbiAgbGV0IGJ1ZiA9IEJ1ZmZlci5hbGxvYygxMyk7XG4gIGJ1Zi53cml0ZVVJbnQzMkJFKHdpZHRoLCAwKTtcbiAgYnVmLndyaXRlVUludDMyQkUoaGVpZ2h0LCA0KTtcbiAgYnVmWzhdID0gdGhpcy5fb3B0aW9ucy5iaXREZXB0aDsgLy8gQml0IGRlcHRoXG4gIGJ1Zls5XSA9IHRoaXMuX29wdGlvbnMuY29sb3JUeXBlOyAvLyBjb2xvclR5cGVcbiAgYnVmWzEwXSA9IDA7IC8vIGNvbXByZXNzaW9uXG4gIGJ1ZlsxMV0gPSAwOyAvLyBmaWx0ZXJcbiAgYnVmWzEyXSA9IDA7IC8vIGludGVybGFjZVxuXG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfSUhEUiwgYnVmKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0lEQVQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX0lEQVQsIGRhdGEpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrSUVORCA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX3BhY2tDaHVuayhjb25zdGFudHMuVFlQRV9JRU5ELCBudWxsKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgU3RyZWFtID0gcmVxdWlyZShcInN0cmVhbVwiKTtcbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyXCIpO1xuXG5sZXQgUGFja2VyQXN5bmMgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0KSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIGxldCBvcHRpb25zID0gb3B0IHx8IHt9O1xuXG4gIHRoaXMuX3BhY2tlciA9IG5ldyBQYWNrZXIob3B0aW9ucyk7XG4gIHRoaXMuX2RlZmxhdGUgPSB0aGlzLl9wYWNrZXIuY3JlYXRlRGVmbGF0ZSgpO1xuXG4gIHRoaXMucmVhZGFibGUgPSB0cnVlO1xufSk7XG51dGlsLmluaGVyaXRzKFBhY2tlckFzeW5jLCBTdHJlYW0pO1xuXG5QYWNrZXJBc3luYy5wcm90b3R5cGUucGFjayA9IGZ1bmN0aW9uIChkYXRhLCB3aWR0aCwgaGVpZ2h0LCBnYW1tYSkge1xuICAvLyBTaWduYXR1cmVcbiAgdGhpcy5lbWl0KFwiZGF0YVwiLCBCdWZmZXIuZnJvbShjb25zdGFudHMuUE5HX1NJR05BVFVSRSkpO1xuICB0aGlzLmVtaXQoXCJkYXRhXCIsIHRoaXMuX3BhY2tlci5wYWNrSUhEUih3aWR0aCwgaGVpZ2h0KSk7XG5cbiAgaWYgKGdhbW1hKSB7XG4gICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0dBTUEoZ2FtbWEpKTtcbiAgfVxuXG4gIGxldCBmaWx0ZXJlZERhdGEgPSB0aGlzLl9wYWNrZXIuZmlsdGVyRGF0YShkYXRhLCB3aWR0aCwgaGVpZ2h0KTtcblxuICAvLyBjb21wcmVzcyBpdFxuICB0aGlzLl9kZWZsYXRlLm9uKFwiZXJyb3JcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlcnJvclwiKSk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5vbihcbiAgICBcImRhdGFcIixcbiAgICBmdW5jdGlvbiAoY29tcHJlc3NlZERhdGEpIHtcbiAgICAgIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJREFUKGNvbXByZXNzZWREYXRhKSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5vbihcbiAgICBcImVuZFwiLFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJRU5EKCkpO1xuICAgICAgdGhpcy5lbWl0KFwiZW5kXCIpO1xuICAgIH0uYmluZCh0aGlzKVxuICApO1xuXG4gIHRoaXMuX2RlZmxhdGUuZW5kKGZpbHRlcmVkRGF0YSk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgYXNzZXJ0ID0gcmVxdWlyZShcImFzc2VydFwiKS5vaztcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xuXG5sZXQga01heExlbmd0aCA9IHJlcXVpcmUoXCJidWZmZXJcIikua01heExlbmd0aDtcblxuZnVuY3Rpb24gSW5mbGF0ZShvcHRzKSB7XG4gIGlmICghKHRoaXMgaW5zdGFuY2VvZiBJbmZsYXRlKSkge1xuICAgIHJldHVybiBuZXcgSW5mbGF0ZShvcHRzKTtcbiAgfVxuXG4gIGlmIChvcHRzICYmIG9wdHMuY2h1bmtTaXplIDwgemxpYi5aX01JTl9DSFVOSykge1xuICAgIG9wdHMuY2h1bmtTaXplID0gemxpYi5aX01JTl9DSFVOSztcbiAgfVxuXG4gIHpsaWIuSW5mbGF0ZS5jYWxsKHRoaXMsIG9wdHMpO1xuXG4gIC8vIE5vZGUgOCAtLT4gOSBjb21wYXRpYmlsaXR5IGNoZWNrXG4gIHRoaXMuX29mZnNldCA9IHRoaXMuX29mZnNldCA9PT0gdW5kZWZpbmVkID8gdGhpcy5fb3V0T2Zmc2V0IDogdGhpcy5fb2Zmc2V0O1xuICB0aGlzLl9idWZmZXIgPSB0aGlzLl9idWZmZXIgfHwgdGhpcy5fb3V0QnVmZmVyO1xuXG4gIGlmIChvcHRzICYmIG9wdHMubWF4TGVuZ3RoICE9IG51bGwpIHtcbiAgICB0aGlzLl9tYXhMZW5ndGggPSBvcHRzLm1heExlbmd0aDtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVJbmZsYXRlKG9wdHMpIHtcbiAgcmV0dXJuIG5ldyBJbmZsYXRlKG9wdHMpO1xufVxuXG5mdW5jdGlvbiBfY2xvc2UoZW5naW5lLCBjYWxsYmFjaykge1xuICBpZiAoY2FsbGJhY2spIHtcbiAgICBwcm9jZXNzLm5leHRUaWNrKGNhbGxiYWNrKTtcbiAgfVxuXG4gIC8vIENhbGxlciBtYXkgaW52b2tlIC5jbG9zZSBhZnRlciBhIHpsaWIgZXJyb3IgKHdoaWNoIHdpbGwgbnVsbCBfaGFuZGxlKS5cbiAgaWYgKCFlbmdpbmUuX2hhbmRsZSkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGVuZ2luZS5faGFuZGxlLmNsb3NlKCk7XG4gIGVuZ2luZS5faGFuZGxlID0gbnVsbDtcbn1cblxuSW5mbGF0ZS5wcm90b3R5cGUuX3Byb2Nlc3NDaHVuayA9IGZ1bmN0aW9uIChjaHVuaywgZmx1c2hGbGFnLCBhc3luY0NiKSB7XG4gIGlmICh0eXBlb2YgYXN5bmNDYiA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcmV0dXJuIHpsaWIuSW5mbGF0ZS5fcHJvY2Vzc0NodW5rLmNhbGwodGhpcywgY2h1bmssIGZsdXNoRmxhZywgYXN5bmNDYik7XG4gIH1cblxuICBsZXQgc2VsZiA9IHRoaXM7XG5cbiAgbGV0IGF2YWlsSW5CZWZvcmUgPSBjaHVuayAmJiBjaHVuay5sZW5ndGg7XG4gIGxldCBhdmFpbE91dEJlZm9yZSA9IHRoaXMuX2NodW5rU2l6ZSAtIHRoaXMuX29mZnNldDtcbiAgbGV0IGxlZnRUb0luZmxhdGUgPSB0aGlzLl9tYXhMZW5ndGg7XG4gIGxldCBpbk9mZiA9IDA7XG5cbiAgbGV0IGJ1ZmZlcnMgPSBbXTtcbiAgbGV0IG5yZWFkID0gMDtcblxuICBsZXQgZXJyb3I7XG4gIHRoaXMub24oXCJlcnJvclwiLCBmdW5jdGlvbiAoZXJyKSB7XG4gICAgZXJyb3IgPSBlcnI7XG4gIH0pO1xuXG4gIGZ1bmN0aW9uIGhhbmRsZUNodW5rKGF2YWlsSW5BZnRlciwgYXZhaWxPdXRBZnRlcikge1xuICAgIGlmIChzZWxmLl9oYWRFcnJvcikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGxldCBoYXZlID0gYXZhaWxPdXRCZWZvcmUgLSBhdmFpbE91dEFmdGVyO1xuICAgIGFzc2VydChoYXZlID49IDAsIFwiaGF2ZSBzaG91bGQgbm90IGdvIGRvd25cIik7XG5cbiAgICBpZiAoaGF2ZSA+IDApIHtcbiAgICAgIGxldCBvdXQgPSBzZWxmLl9idWZmZXIuc2xpY2Uoc2VsZi5fb2Zmc2V0LCBzZWxmLl9vZmZzZXQgKyBoYXZlKTtcbiAgICAgIHNlbGYuX29mZnNldCArPSBoYXZlO1xuXG4gICAgICBpZiAob3V0Lmxlbmd0aCA+IGxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgb3V0ID0gb3V0LnNsaWNlKDAsIGxlZnRUb0luZmxhdGUpO1xuICAgICAgfVxuXG4gICAgICBidWZmZXJzLnB1c2gob3V0KTtcbiAgICAgIG5yZWFkICs9IG91dC5sZW5ndGg7XG4gICAgICBsZWZ0VG9JbmZsYXRlIC09IG91dC5sZW5ndGg7XG5cbiAgICAgIGlmIChsZWZ0VG9JbmZsYXRlID09PSAwKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoYXZhaWxPdXRBZnRlciA9PT0gMCB8fCBzZWxmLl9vZmZzZXQgPj0gc2VsZi5fY2h1bmtTaXplKSB7XG4gICAgICBhdmFpbE91dEJlZm9yZSA9IHNlbGYuX2NodW5rU2l6ZTtcbiAgICAgIHNlbGYuX29mZnNldCA9IDA7XG4gICAgICBzZWxmLl9idWZmZXIgPSBCdWZmZXIuYWxsb2NVbnNhZmUoc2VsZi5fY2h1bmtTaXplKTtcbiAgICB9XG5cbiAgICBpZiAoYXZhaWxPdXRBZnRlciA9PT0gMCkge1xuICAgICAgaW5PZmYgKz0gYXZhaWxJbkJlZm9yZSAtIGF2YWlsSW5BZnRlcjtcbiAgICAgIGF2YWlsSW5CZWZvcmUgPSBhdmFpbEluQWZ0ZXI7XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGFzc2VydCh0aGlzLl9oYW5kbGUsIFwiemxpYiBiaW5kaW5nIGNsb3NlZFwiKTtcbiAgbGV0IHJlcztcbiAgZG8ge1xuICAgIHJlcyA9IHRoaXMuX2hhbmRsZS53cml0ZVN5bmMoXG4gICAgICBmbHVzaEZsYWcsXG4gICAgICBjaHVuaywgLy8gaW5cbiAgICAgIGluT2ZmLCAvLyBpbl9vZmZcbiAgICAgIGF2YWlsSW5CZWZvcmUsIC8vIGluX2xlblxuICAgICAgdGhpcy5fYnVmZmVyLCAvLyBvdXRcbiAgICAgIHRoaXMuX29mZnNldCwgLy9vdXRfb2ZmXG4gICAgICBhdmFpbE91dEJlZm9yZVxuICAgICk7IC8vIG91dF9sZW5cbiAgICAvLyBOb2RlIDggLS0+IDkgY29tcGF0aWJpbGl0eSBjaGVja1xuICAgIHJlcyA9IHJlcyB8fCB0aGlzLl93cml0ZVN0YXRlO1xuICB9IHdoaWxlICghdGhpcy5faGFkRXJyb3IgJiYgaGFuZGxlQ2h1bmsocmVzWzBdLCByZXNbMV0pKTtcblxuICBpZiAodGhpcy5faGFkRXJyb3IpIHtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIGlmIChucmVhZCA+PSBrTWF4TGVuZ3RoKSB7XG4gICAgX2Nsb3NlKHRoaXMpO1xuICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFxuICAgICAgXCJDYW5ub3QgY3JlYXRlIGZpbmFsIEJ1ZmZlci4gSXQgd291bGQgYmUgbGFyZ2VyIHRoYW4gMHhcIiArXG4gICAgICAgIGtNYXhMZW5ndGgudG9TdHJpbmcoMTYpICtcbiAgICAgICAgXCIgYnl0ZXNcIlxuICAgICk7XG4gIH1cblxuICBsZXQgYnVmID0gQnVmZmVyLmNvbmNhdChidWZmZXJzLCBucmVhZCk7XG4gIF9jbG9zZSh0aGlzKTtcblxuICByZXR1cm4gYnVmO1xufTtcblxudXRpbC5pbmhlcml0cyhJbmZsYXRlLCB6bGliLkluZmxhdGUpO1xuXG5mdW5jdGlvbiB6bGliQnVmZmVyU3luYyhlbmdpbmUsIGJ1ZmZlcikge1xuICBpZiAodHlwZW9mIGJ1ZmZlciA9PT0gXCJzdHJpbmdcIikge1xuICAgIGJ1ZmZlciA9IEJ1ZmZlci5mcm9tKGJ1ZmZlcik7XG4gIH1cbiAgaWYgKCEoYnVmZmVyIGluc3RhbmNlb2YgQnVmZmVyKSkge1xuICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJOb3QgYSBzdHJpbmcgb3IgYnVmZmVyXCIpO1xuICB9XG5cbiAgbGV0IGZsdXNoRmxhZyA9IGVuZ2luZS5fZmluaXNoRmx1c2hGbGFnO1xuICBpZiAoZmx1c2hGbGFnID09IG51bGwpIHtcbiAgICBmbHVzaEZsYWcgPSB6bGliLlpfRklOSVNIO1xuICB9XG5cbiAgcmV0dXJuIGVuZ2luZS5fcHJvY2Vzc0NodW5rKGJ1ZmZlciwgZmx1c2hGbGFnKTtcbn1cblxuZnVuY3Rpb24gaW5mbGF0ZVN5bmMoYnVmZmVyLCBvcHRzKSB7XG4gIHJldHVybiB6bGliQnVmZmVyU3luYyhuZXcgSW5mbGF0ZShvcHRzKSwgYnVmZmVyKTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBleHBvcnRzID0gaW5mbGF0ZVN5bmM7XG5leHBvcnRzLkluZmxhdGUgPSBJbmZsYXRlO1xuZXhwb3J0cy5jcmVhdGVJbmZsYXRlID0gY3JlYXRlSW5mbGF0ZTtcbmV4cG9ydHMuaW5mbGF0ZVN5bmMgPSBpbmZsYXRlU3luYztcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IFN5bmNSZWFkZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoYnVmZmVyKSB7XG4gIHRoaXMuX2J1ZmZlciA9IGJ1ZmZlcjtcbiAgdGhpcy5fcmVhZHMgPSBbXTtcbn0pO1xuXG5TeW5jUmVhZGVyLnByb3RvdHlwZS5yZWFkID0gZnVuY3Rpb24gKGxlbmd0aCwgY2FsbGJhY2spIHtcbiAgdGhpcy5fcmVhZHMucHVzaCh7XG4gICAgbGVuZ3RoOiBNYXRoLmFicyhsZW5ndGgpLCAvLyBpZiBsZW5ndGggPCAwIHRoZW4gYXQgbW9zdCB0aGlzIGxlbmd0aFxuICAgIGFsbG93TGVzczogbGVuZ3RoIDwgMCxcbiAgICBmdW5jOiBjYWxsYmFjayxcbiAgfSk7XG59O1xuXG5TeW5jUmVhZGVyLnByb3RvdHlwZS5wcm9jZXNzID0gZnVuY3Rpb24gKCkge1xuICAvLyBhcyBsb25nIGFzIHRoZXJlIGlzIGFueSBkYXRhIGFuZCByZWFkIHJlcXVlc3RzXG4gIHdoaWxlICh0aGlzLl9yZWFkcy5sZW5ndGggPiAwICYmIHRoaXMuX2J1ZmZlci5sZW5ndGgpIHtcbiAgICBsZXQgcmVhZCA9IHRoaXMuX3JlYWRzWzBdO1xuXG4gICAgaWYgKFxuICAgICAgdGhpcy5fYnVmZmVyLmxlbmd0aCAmJlxuICAgICAgKHRoaXMuX2J1ZmZlci5sZW5ndGggPj0gcmVhZC5sZW5ndGggfHwgcmVhZC5hbGxvd0xlc3MpXG4gICAgKSB7XG4gICAgICAvLyBvayB0aGVyZSBpcyBhbnkgZGF0YSBzbyB0aGF0IHdlIGNhbiBzYXRpc2Z5IHRoaXMgcmVxdWVzdFxuICAgICAgdGhpcy5fcmVhZHMuc2hpZnQoKTsgLy8gPT0gcmVhZFxuXG4gICAgICBsZXQgYnVmID0gdGhpcy5fYnVmZmVyO1xuXG4gICAgICB0aGlzLl9idWZmZXIgPSBidWYuc2xpY2UocmVhZC5sZW5ndGgpO1xuXG4gICAgICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBidWYuc2xpY2UoMCwgcmVhZC5sZW5ndGgpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgaWYgKHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJUaGVyZSBhcmUgc29tZSByZWFkIHJlcXVlc3RzIHdhaXRuZyBvbiBmaW5pc2hlZCBzdHJlYW1cIik7XG4gIH1cblxuICBpZiAodGhpcy5fYnVmZmVyLmxlbmd0aCA+IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgY29udGVudCBhdCBlbmQgb2Ygc3RyZWFtXCIpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgU3luY1JlYWRlciA9IHJlcXVpcmUoXCIuL3N5bmMtcmVhZGVyXCIpO1xubGV0IEZpbHRlciA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZVwiKTtcblxuZXhwb3J0cy5wcm9jZXNzID0gZnVuY3Rpb24gKGluQnVmZmVyLCBiaXRtYXBJbmZvKSB7XG4gIGxldCBvdXRCdWZmZXJzID0gW107XG4gIGxldCByZWFkZXIgPSBuZXcgU3luY1JlYWRlcihpbkJ1ZmZlcik7XG4gIGxldCBmaWx0ZXIgPSBuZXcgRmlsdGVyKGJpdG1hcEluZm8sIHtcbiAgICByZWFkOiByZWFkZXIucmVhZC5iaW5kKHJlYWRlciksXG4gICAgd3JpdGU6IGZ1bmN0aW9uIChidWZmZXJQYXJ0KSB7XG4gICAgICBvdXRCdWZmZXJzLnB1c2goYnVmZmVyUGFydCk7XG4gICAgfSxcbiAgICBjb21wbGV0ZTogZnVuY3Rpb24gKCkge30sXG4gIH0pO1xuXG4gIGZpbHRlci5zdGFydCgpO1xuICByZWFkZXIucHJvY2VzcygpO1xuXG4gIHJldHVybiBCdWZmZXIuY29uY2F0KG91dEJ1ZmZlcnMpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGhhc1N5bmNabGliID0gdHJ1ZTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5sZXQgaW5mbGF0ZVN5bmMgPSByZXF1aXJlKFwiLi9zeW5jLWluZmxhdGVcIik7XG5pZiAoIXpsaWIuZGVmbGF0ZVN5bmMpIHtcbiAgaGFzU3luY1psaWIgPSBmYWxzZTtcbn1cbmxldCBTeW5jUmVhZGVyID0gcmVxdWlyZShcIi4vc3luYy1yZWFkZXJcIik7XG5sZXQgRmlsdGVyU3luYyA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZS1zeW5jXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlclwiKTtcbmxldCBiaXRtYXBwZXIgPSByZXF1aXJlKFwiLi9iaXRtYXBwZXJcIik7XG5sZXQgZm9ybWF0Tm9ybWFsaXNlciA9IHJlcXVpcmUoXCIuL2Zvcm1hdC1ub3JtYWxpc2VyXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChidWZmZXIsIG9wdGlvbnMpIHtcbiAgaWYgKCFoYXNTeW5jWmxpYikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIFwiVG8gdXNlIHRoZSBzeW5jIGNhcGFiaWxpdHkgb2YgdGhpcyBsaWJyYXJ5IGluIG9sZCBub2RlIHZlcnNpb25zLCBwbGVhc2UgcGluIHBuZ2pzIHRvIHYyLjMuMFwiXG4gICAgKTtcbiAgfVxuXG4gIGxldCBlcnI7XG4gIGZ1bmN0aW9uIGhhbmRsZUVycm9yKF9lcnJfKSB7XG4gICAgZXJyID0gX2Vycl87XG4gIH1cblxuICBsZXQgbWV0YURhdGE7XG4gIGZ1bmN0aW9uIGhhbmRsZU1ldGFEYXRhKF9tZXRhRGF0YV8pIHtcbiAgICBtZXRhRGF0YSA9IF9tZXRhRGF0YV87XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVUcmFuc0NvbG9yKHRyYW5zQ29sb3IpIHtcbiAgICBtZXRhRGF0YS50cmFuc0NvbG9yID0gdHJhbnNDb2xvcjtcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVBhbGV0dGUocGFsZXR0ZSkge1xuICAgIG1ldGFEYXRhLnBhbGV0dGUgPSBwYWxldHRlO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlU2ltcGxlVHJhbnNwYXJlbmN5KCkge1xuICAgIG1ldGFEYXRhLmFscGhhID0gdHJ1ZTtcbiAgfVxuXG4gIGxldCBnYW1tYTtcbiAgZnVuY3Rpb24gaGFuZGxlR2FtbWEoX2dhbW1hXykge1xuICAgIGdhbW1hID0gX2dhbW1hXztcbiAgfVxuXG4gIGxldCBpbmZsYXRlRGF0YUxpc3QgPSBbXTtcbiAgZnVuY3Rpb24gaGFuZGxlSW5mbGF0ZURhdGEoaW5mbGF0ZWREYXRhKSB7XG4gICAgaW5mbGF0ZURhdGFMaXN0LnB1c2goaW5mbGF0ZWREYXRhKTtcbiAgfVxuXG4gIGxldCByZWFkZXIgPSBuZXcgU3luY1JlYWRlcihidWZmZXIpO1xuXG4gIGxldCBwYXJzZXIgPSBuZXcgUGFyc2VyKG9wdGlvbnMsIHtcbiAgICByZWFkOiByZWFkZXIucmVhZC5iaW5kKHJlYWRlciksXG4gICAgZXJyb3I6IGhhbmRsZUVycm9yLFxuICAgIG1ldGFkYXRhOiBoYW5kbGVNZXRhRGF0YSxcbiAgICBnYW1tYTogaGFuZGxlR2FtbWEsXG4gICAgcGFsZXR0ZTogaGFuZGxlUGFsZXR0ZSxcbiAgICB0cmFuc0NvbG9yOiBoYW5kbGVUcmFuc0NvbG9yLFxuICAgIGluZmxhdGVEYXRhOiBoYW5kbGVJbmZsYXRlRGF0YSxcbiAgICBzaW1wbGVUcmFuc3BhcmVuY3k6IGhhbmRsZVNpbXBsZVRyYW5zcGFyZW5jeSxcbiAgfSk7XG5cbiAgcGFyc2VyLnN0YXJ0KCk7XG4gIHJlYWRlci5wcm9jZXNzKCk7XG5cbiAgaWYgKGVycikge1xuICAgIHRocm93IGVycjtcbiAgfVxuXG4gIC8vam9pbiB0b2dldGhlciB0aGUgaW5mbGF0ZSBkYXRhc1xuICBsZXQgaW5mbGF0ZURhdGEgPSBCdWZmZXIuY29uY2F0KGluZmxhdGVEYXRhTGlzdCk7XG4gIGluZmxhdGVEYXRhTGlzdC5sZW5ndGggPSAwO1xuXG4gIGxldCBpbmZsYXRlZERhdGE7XG4gIGlmIChtZXRhRGF0YS5pbnRlcmxhY2UpIHtcbiAgICBpbmZsYXRlZERhdGEgPSB6bGliLmluZmxhdGVTeW5jKGluZmxhdGVEYXRhKTtcbiAgfSBlbHNlIHtcbiAgICBsZXQgcm93U2l6ZSA9XG4gICAgICAoKG1ldGFEYXRhLndpZHRoICogbWV0YURhdGEuYnBwICogbWV0YURhdGEuZGVwdGggKyA3KSA+PiAzKSArIDE7XG4gICAgbGV0IGltYWdlU2l6ZSA9IHJvd1NpemUgKiBtZXRhRGF0YS5oZWlnaHQ7XG4gICAgaW5mbGF0ZWREYXRhID0gaW5mbGF0ZVN5bmMoaW5mbGF0ZURhdGEsIHtcbiAgICAgIGNodW5rU2l6ZTogaW1hZ2VTaXplLFxuICAgICAgbWF4TGVuZ3RoOiBpbWFnZVNpemUsXG4gICAgfSk7XG4gIH1cbiAgaW5mbGF0ZURhdGEgPSBudWxsO1xuXG4gIGlmICghaW5mbGF0ZWREYXRhIHx8ICFpbmZsYXRlZERhdGEubGVuZ3RoKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYmFkIHBuZyAtIGludmFsaWQgaW5mbGF0ZSBkYXRhIHJlc3BvbnNlXCIpO1xuICB9XG5cbiAgbGV0IHVuZmlsdGVyZWREYXRhID0gRmlsdGVyU3luYy5wcm9jZXNzKGluZmxhdGVkRGF0YSwgbWV0YURhdGEpO1xuICBpbmZsYXRlRGF0YSA9IG51bGw7XG5cbiAgbGV0IGJpdG1hcERhdGEgPSBiaXRtYXBwZXIuZGF0YVRvQml0TWFwKHVuZmlsdGVyZWREYXRhLCBtZXRhRGF0YSk7XG4gIHVuZmlsdGVyZWREYXRhID0gbnVsbDtcblxuICBsZXQgbm9ybWFsaXNlZEJpdG1hcERhdGEgPSBmb3JtYXROb3JtYWxpc2VyKFxuICAgIGJpdG1hcERhdGEsXG4gICAgbWV0YURhdGEsXG4gICAgb3B0aW9ucy5za2lwUmVzY2FsZVxuICApO1xuXG4gIG1ldGFEYXRhLmRhdGEgPSBub3JtYWxpc2VkQml0bWFwRGF0YTtcbiAgbWV0YURhdGEuZ2FtbWEgPSBnYW1tYSB8fCAwO1xuXG4gIHJldHVybiBtZXRhRGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBoYXNTeW5jWmxpYiA9IHRydWU7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xuaWYgKCF6bGliLmRlZmxhdGVTeW5jKSB7XG4gIGhhc1N5bmNabGliID0gZmFsc2U7XG59XG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IFBhY2tlciA9IHJlcXVpcmUoXCIuL3BhY2tlclwiKTtcblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAobWV0YURhdGEsIG9wdCkge1xuICBpZiAoIWhhc1N5bmNabGliKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJUbyB1c2UgdGhlIHN5bmMgY2FwYWJpbGl0eSBvZiB0aGlzIGxpYnJhcnkgaW4gb2xkIG5vZGUgdmVyc2lvbnMsIHBsZWFzZSBwaW4gcG5nanMgdG8gdjIuMy4wXCJcbiAgICApO1xuICB9XG5cbiAgbGV0IG9wdGlvbnMgPSBvcHQgfHwge307XG5cbiAgbGV0IHBhY2tlciA9IG5ldyBQYWNrZXIob3B0aW9ucyk7XG5cbiAgbGV0IGNodW5rcyA9IFtdO1xuXG4gIC8vIFNpZ25hdHVyZVxuICBjaHVua3MucHVzaChCdWZmZXIuZnJvbShjb25zdGFudHMuUE5HX1NJR05BVFVSRSkpO1xuXG4gIC8vIEhlYWRlclxuICBjaHVua3MucHVzaChwYWNrZXIucGFja0lIRFIobWV0YURhdGEud2lkdGgsIG1ldGFEYXRhLmhlaWdodCkpO1xuXG4gIGlmIChtZXRhRGF0YS5nYW1tYSkge1xuICAgIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrR0FNQShtZXRhRGF0YS5nYW1tYSkpO1xuICB9XG5cbiAgbGV0IGZpbHRlcmVkRGF0YSA9IHBhY2tlci5maWx0ZXJEYXRhKFxuICAgIG1ldGFEYXRhLmRhdGEsXG4gICAgbWV0YURhdGEud2lkdGgsXG4gICAgbWV0YURhdGEuaGVpZ2h0XG4gICk7XG5cbiAgLy8gY29tcHJlc3MgaXRcbiAgbGV0IGNvbXByZXNzZWREYXRhID0gemxpYi5kZWZsYXRlU3luYyhcbiAgICBmaWx0ZXJlZERhdGEsXG4gICAgcGFja2VyLmdldERlZmxhdGVPcHRpb25zKClcbiAgKTtcbiAgZmlsdGVyZWREYXRhID0gbnVsbDtcblxuICBpZiAoIWNvbXByZXNzZWREYXRhIHx8ICFjb21wcmVzc2VkRGF0YS5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiYWQgcG5nIC0gaW52YWxpZCBjb21wcmVzc2VkIGRhdGEgcmVzcG9uc2VcIik7XG4gIH1cbiAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tJREFUKGNvbXByZXNzZWREYXRhKSk7XG5cbiAgLy8gRW5kXG4gIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrSUVORCgpKTtcblxuICByZXR1cm4gQnVmZmVyLmNvbmNhdChjaHVua3MpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHBhcnNlID0gcmVxdWlyZShcIi4vcGFyc2VyLXN5bmNcIik7XG5sZXQgcGFjayA9IHJlcXVpcmUoXCIuL3BhY2tlci1zeW5jXCIpO1xuXG5leHBvcnRzLnJlYWQgPSBmdW5jdGlvbiAoYnVmZmVyLCBvcHRpb25zKSB7XG4gIHJldHVybiBwYXJzZShidWZmZXIsIG9wdGlvbnMgfHwge30pO1xufTtcblxuZXhwb3J0cy53cml0ZSA9IGZ1bmN0aW9uIChwbmcsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIHBhY2socG5nLCBvcHRpb25zKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgU3RyZWFtID0gcmVxdWlyZShcInN0cmVhbVwiKTtcbmxldCBQYXJzZXIgPSByZXF1aXJlKFwiLi9wYXJzZXItYXN5bmNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyLWFzeW5jXCIpO1xubGV0IFBOR1N5bmMgPSByZXF1aXJlKFwiLi9wbmctc3luY1wiKTtcblxubGV0IFBORyA9IChleHBvcnRzLlBORyA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIFN0cmVhbS5jYWxsKHRoaXMpO1xuXG4gIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9OyAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG5vLXBhcmFtLXJlYXNzaWduXG5cbiAgLy8gY29lcmNlIHBpeGVsIGRpbWVuc2lvbnMgdG8gaW50ZWdlcnMgKGFsc28gY29lcmNlcyB1bmRlZmluZWQgLT4gMCk6XG4gIHRoaXMud2lkdGggPSBvcHRpb25zLndpZHRoIHwgMDtcbiAgdGhpcy5oZWlnaHQgPSBvcHRpb25zLmhlaWdodCB8IDA7XG5cbiAgdGhpcy5kYXRhID1cbiAgICB0aGlzLndpZHRoID4gMCAmJiB0aGlzLmhlaWdodCA+IDBcbiAgICAgID8gQnVmZmVyLmFsbG9jKDQgKiB0aGlzLndpZHRoICogdGhpcy5oZWlnaHQpXG4gICAgICA6IG51bGw7XG5cbiAgaWYgKG9wdGlvbnMuZmlsbCAmJiB0aGlzLmRhdGEpIHtcbiAgICB0aGlzLmRhdGEuZmlsbCgwKTtcbiAgfVxuXG4gIHRoaXMuZ2FtbWEgPSAwO1xuICB0aGlzLnJlYWRhYmxlID0gdGhpcy53cml0YWJsZSA9IHRydWU7XG5cbiAgdGhpcy5fcGFyc2VyID0gbmV3IFBhcnNlcihvcHRpb25zKTtcblxuICB0aGlzLl9wYXJzZXIub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFwiY2xvc2VcIiwgdGhpcy5faGFuZGxlQ2xvc2UuYmluZCh0aGlzKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcIm1ldGFkYXRhXCIsIHRoaXMuX21ldGFkYXRhLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYXJzZXIub24oXCJnYW1tYVwiLCB0aGlzLl9nYW1tYS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFxuICAgIFwicGFyc2VkXCIsXG4gICAgZnVuY3Rpb24gKGRhdGEpIHtcbiAgICAgIHRoaXMuZGF0YSA9IGRhdGE7XG4gICAgICB0aGlzLmVtaXQoXCJwYXJzZWRcIiwgZGF0YSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcbiAgdGhpcy5fcGFja2VyLm9uKFwiZGF0YVwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImRhdGFcIikpO1xuICB0aGlzLl9wYWNrZXIub24oXCJlbmRcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlbmRcIikpO1xuICB0aGlzLl9wYXJzZXIub24oXCJjbG9zZVwiLCB0aGlzLl9oYW5kbGVDbG9zZS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFja2VyLm9uKFwiZXJyb3JcIiwgdGhpcy5lbWl0LmJpbmQodGhpcywgXCJlcnJvclwiKSk7XG59KTtcbnV0aWwuaW5oZXJpdHMoUE5HLCBTdHJlYW0pO1xuXG5QTkcuc3luYyA9IFBOR1N5bmM7XG5cblBORy5wcm90b3R5cGUucGFjayA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLmRhdGEgfHwgIXRoaXMuZGF0YS5sZW5ndGgpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBcIk5vIGRhdGEgcHJvdmlkZWRcIik7XG4gICAgcmV0dXJuIHRoaXM7XG4gIH1cblxuICBwcm9jZXNzLm5leHRUaWNrKFxuICAgIGZ1bmN0aW9uICgpIHtcbiAgICAgIHRoaXMuX3BhY2tlci5wYWNrKHRoaXMuZGF0YSwgdGhpcy53aWR0aCwgdGhpcy5oZWlnaHQsIHRoaXMuZ2FtbWEpO1xuICAgIH0uYmluZCh0aGlzKVxuICApO1xuXG4gIHJldHVybiB0aGlzO1xufTtcblxuUE5HLnByb3RvdHlwZS5wYXJzZSA9IGZ1bmN0aW9uIChkYXRhLCBjYWxsYmFjaykge1xuICBpZiAoY2FsbGJhY2spIHtcbiAgICBsZXQgb25QYXJzZWQsIG9uRXJyb3I7XG5cbiAgICBvblBhcnNlZCA9IGZ1bmN0aW9uIChwYXJzZWREYXRhKSB7XG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKFwiZXJyb3JcIiwgb25FcnJvcik7XG5cbiAgICAgIHRoaXMuZGF0YSA9IHBhcnNlZERhdGE7XG4gICAgICBjYWxsYmFjayhudWxsLCB0aGlzKTtcbiAgICB9LmJpbmQodGhpcyk7XG5cbiAgICBvbkVycm9yID0gZnVuY3Rpb24gKGVycikge1xuICAgICAgdGhpcy5yZW1vdmVMaXN0ZW5lcihcInBhcnNlZFwiLCBvblBhcnNlZCk7XG5cbiAgICAgIGNhbGxiYWNrKGVyciwgbnVsbCk7XG4gICAgfS5iaW5kKHRoaXMpO1xuXG4gICAgdGhpcy5vbmNlKFwicGFyc2VkXCIsIG9uUGFyc2VkKTtcbiAgICB0aGlzLm9uY2UoXCJlcnJvclwiLCBvbkVycm9yKTtcbiAgfVxuXG4gIHRoaXMuZW5kKGRhdGEpO1xuICByZXR1cm4gdGhpcztcbn07XG5cblBORy5wcm90b3R5cGUud3JpdGUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9wYXJzZXIud3JpdGUoZGF0YSk7XG4gIHJldHVybiB0cnVlO1xufTtcblxuUE5HLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9wYXJzZXIuZW5kKGRhdGEpO1xufTtcblxuUE5HLnByb3RvdHlwZS5fbWV0YWRhdGEgPSBmdW5jdGlvbiAobWV0YWRhdGEpIHtcbiAgdGhpcy53aWR0aCA9IG1ldGFkYXRhLndpZHRoO1xuICB0aGlzLmhlaWdodCA9IG1ldGFkYXRhLmhlaWdodDtcblxuICB0aGlzLmVtaXQoXCJtZXRhZGF0YVwiLCBtZXRhZGF0YSk7XG59O1xuXG5QTkcucHJvdG90eXBlLl9nYW1tYSA9IGZ1bmN0aW9uIChnYW1tYSkge1xuICB0aGlzLmdhbW1hID0gZ2FtbWE7XG59O1xuXG5QTkcucHJvdG90eXBlLl9oYW5kbGVDbG9zZSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLl9wYXJzZXIud3JpdGFibGUgJiYgIXRoaXMuX3BhY2tlci5yZWFkYWJsZSkge1xuICAgIHRoaXMuZW1pdChcImNsb3NlXCIpO1xuICB9XG59O1xuXG5QTkcuYml0Ymx0ID0gZnVuY3Rpb24gKHNyYywgZHN0LCBzcmNYLCBzcmNZLCB3aWR0aCwgaGVpZ2h0LCBkZWx0YVgsIGRlbHRhWSkge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcbiAgLy8gY29lcmNlIHBpeGVsIGRpbWVuc2lvbnMgdG8gaW50ZWdlcnMgKGFsc28gY29lcmNlcyB1bmRlZmluZWQgLT4gMCk6XG4gIC8qIGVzbGludC1kaXNhYmxlIG5vLXBhcmFtLXJlYXNzaWduICovXG4gIHNyY1ggfD0gMDtcbiAgc3JjWSB8PSAwO1xuICB3aWR0aCB8PSAwO1xuICBoZWlnaHQgfD0gMDtcbiAgZGVsdGFYIHw9IDA7XG4gIGRlbHRhWSB8PSAwO1xuICAvKiBlc2xpbnQtZW5hYmxlIG5vLXBhcmFtLXJlYXNzaWduICovXG5cbiAgaWYgKFxuICAgIHNyY1ggPiBzcmMud2lkdGggfHxcbiAgICBzcmNZID4gc3JjLmhlaWdodCB8fFxuICAgIHNyY1ggKyB3aWR0aCA+IHNyYy53aWR0aCB8fFxuICAgIHNyY1kgKyBoZWlnaHQgPiBzcmMuaGVpZ2h0XG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJpdGJsdCByZWFkaW5nIG91dHNpZGUgaW1hZ2VcIik7XG4gIH1cblxuICBpZiAoXG4gICAgZGVsdGFYID4gZHN0LndpZHRoIHx8XG4gICAgZGVsdGFZID4gZHN0LmhlaWdodCB8fFxuICAgIGRlbHRhWCArIHdpZHRoID4gZHN0LndpZHRoIHx8XG4gICAgZGVsdGFZICsgaGVpZ2h0ID4gZHN0LmhlaWdodFxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiaXRibHQgd3JpdGluZyBvdXRzaWRlIGltYWdlXCIpO1xuICB9XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIHNyYy5kYXRhLmNvcHkoXG4gICAgICBkc3QuZGF0YSxcbiAgICAgICgoZGVsdGFZICsgeSkgKiBkc3Qud2lkdGggKyBkZWx0YVgpIDw8IDIsXG4gICAgICAoKHNyY1kgKyB5KSAqIHNyYy53aWR0aCArIHNyY1gpIDw8IDIsXG4gICAgICAoKHNyY1kgKyB5KSAqIHNyYy53aWR0aCArIHNyY1ggKyB3aWR0aCkgPDwgMlxuICAgICk7XG4gIH1cbn07XG5cblBORy5wcm90b3R5cGUuYml0Ymx0ID0gZnVuY3Rpb24gKFxuICBkc3QsXG4gIHNyY1gsXG4gIHNyY1ksXG4gIHdpZHRoLFxuICBoZWlnaHQsXG4gIGRlbHRhWCxcbiAgZGVsdGFZXG4pIHtcbiAgLy8gZXNsaW50LWRpc2FibGUtbGluZSBtYXgtcGFyYW1zXG5cbiAgUE5HLmJpdGJsdCh0aGlzLCBkc3QsIHNyY1gsIHNyY1ksIHdpZHRoLCBoZWlnaHQsIGRlbHRhWCwgZGVsdGFZKTtcbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5QTkcuYWRqdXN0R2FtbWEgPSBmdW5jdGlvbiAoc3JjKSB7XG4gIGlmIChzcmMuZ2FtbWEpIHtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHNyYy5oZWlnaHQ7IHkrKykge1xuICAgICAgZm9yIChsZXQgeCA9IDA7IHggPCBzcmMud2lkdGg7IHgrKykge1xuICAgICAgICBsZXQgaWR4ID0gKHNyYy53aWR0aCAqIHkgKyB4KSA8PCAyO1xuXG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgMzsgaSsrKSB7XG4gICAgICAgICAgbGV0IHNhbXBsZSA9IHNyYy5kYXRhW2lkeCArIGldIC8gMjU1O1xuICAgICAgICAgIHNhbXBsZSA9IE1hdGgucG93KHNhbXBsZSwgMSAvIDIuMiAvIHNyYy5nYW1tYSk7XG4gICAgICAgICAgc3JjLmRhdGFbaWR4ICsgaV0gPSBNYXRoLnJvdW5kKHNhbXBsZSAqIDI1NSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgc3JjLmdhbW1hID0gMDtcbiAgfVxufTtcblxuUE5HLnByb3RvdHlwZS5hZGp1c3RHYW1tYSA9IGZ1bmN0aW9uICgpIHtcbiAgUE5HLmFkanVzdEdhbW1hKHRoaXMpO1xufTtcbiIsICJpbXBvcnQgeyBQTkcgfSBmcm9tICdwbmdqcyc7XG5cbmNvbnN0IFNJR05BVFVSRSA9IEJ1ZmZlci5mcm9tKFsxMzcsIDgwLCA3OCwgNzEsIDEzLCAxMCwgMjYsIDEwXSk7XG5jb25zdCBNQVhfUElYRUxTID0gMTYgKiAxMDI0ICogMTAyNDtcbmNvbnN0IE1BWF9CWVRFUyA9IDY0ICogMTAyNCAqIDEwMjQ7XG5jb25zdCBDT0xPUl9DSFVOS1MgPSBuZXcgU2V0KFsnZ0FNQScsICdjSFJNJywgJ3NSR0InLCAnaUNDUCcsICdwSFlzJ10pO1xuXG5mdW5jdGlvbiBkaW1lbnNpb25zKHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih3aWR0aCkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGhlaWdodCkgfHwgd2lkdGggPCAxIHx8IGhlaWdodCA8IDFcbiAgICAgICAgfHwgd2lkdGggPiA4MTkyIHx8IGhlaWdodCA+IDgxOTIgfHwgd2lkdGggKiBoZWlnaHQgPiBNQVhfUElYRUxTKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignSU1BR0UgXHU1ODZCXHU1MTQ1XHU1QzNBXHU1QkY4XHU4RDg1XHU4RkM3XHU1Qjg5XHU1MTY4XHU1OTA0XHU3NDA2XHU4MzAzXHU1NkY0XHVGRjA4XHU1MzU1XHU4RkI5IDgxOTJcdUZGMENcdTU0MDhcdThCQTEgMTYwMCBcdTRFMDdcdTUwQ0ZcdTdEMjBcdUZGMDlcdTMwMDInKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGluc3BlY3QoY29udGVudHM6IEJ1ZmZlcik6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IG1ldGFkYXRhOiBCdWZmZXJbXSB9IHtcbiAgICBpZiAoY29udGVudHMubGVuZ3RoIDwgNDUgfHwgY29udGVudHMubGVuZ3RoID4gTUFYX0JZVEVTIHx8ICFjb250ZW50cy5zdWJhcnJheSgwLCA4KS5lcXVhbHMoU0lHTkFUVVJFKVxuICAgICAgICB8fCBjb250ZW50cy5yZWFkVUludDMyQkUoOCkgIT09IDEzIHx8IGNvbnRlbnRzLnRvU3RyaW5nKCdhc2NpaScsIDEyLCAxNikgIT09ICdJSERSJykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0lNQUdFIFx1NkU5MFx1NTZGRVx1NzI0N1x1NEUwRFx1NjYyRlx1NjcwOVx1NjU0OFx1NzY4NCBQTkdcdTMwMDInKTtcbiAgICB9XG4gICAgY29uc3Qgd2lkdGggPSBjb250ZW50cy5yZWFkVUludDMyQkUoMTYpLCBoZWlnaHQgPSBjb250ZW50cy5yZWFkVUludDMyQkUoMjApO1xuICAgIGRpbWVuc2lvbnMod2lkdGgsIGhlaWdodCk7XG4gICAgaWYgKGNvbnRlbnRzWzI0XSA+IDgpIHRocm93IG5ldyBFcnJvcignXHU2NjgyXHU0RTBEXHU2NTJGXHU2MzAxXHU5MUNEXHU5MUM3XHU2ODM3XHU5QUQ4XHU0RjREXHU2REYxIElNQUdFIFx1NTg2Qlx1NTE0NVx1MzAwMicpO1xuICAgIGNvbnN0IG1ldGFkYXRhOiBCdWZmZXJbXSA9IFtdO1xuICAgIGZvciAobGV0IG9mZnNldCA9IDg7IG9mZnNldCArIDEyIDw9IGNvbnRlbnRzLmxlbmd0aDspIHtcbiAgICAgICAgY29uc3QgZW5kID0gb2Zmc2V0ICsgMTIgKyBjb250ZW50cy5yZWFkVUludDMyQkUob2Zmc2V0KTtcbiAgICAgICAgaWYgKGVuZCA+IGNvbnRlbnRzLmxlbmd0aCkgYnJlYWs7XG4gICAgICAgIGNvbnN0IHR5cGUgPSBjb250ZW50cy50b1N0cmluZygnYXNjaWknLCBvZmZzZXQgKyA0LCBvZmZzZXQgKyA4KTtcbiAgICAgICAgaWYgKFsnYWNUTCcsICdmY1RMJywgJ2ZkQVQnLCAnc0JJVCddLmluY2x1ZGVzKHR5cGUpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1x1NjY4Mlx1NEUwRFx1NjUyRlx1NjMwMVx1OTFDRFx1OTFDN1x1NjgzN1x1NTJBOFx1NzUzQlx1NjIxNlx1NzI3OVx1NkI4QVx1NEY0RFx1NkRGMSBJTUFHRSBcdTU4NkJcdTUxNDVcdTMwMDInKTtcbiAgICAgICAgfVxuICAgICAgICBpZiAoQ09MT1JfQ0hVTktTLmhhcyh0eXBlKSkgbWV0YWRhdGEucHVzaChjb250ZW50cy5zdWJhcnJheShvZmZzZXQsIGVuZCkpO1xuICAgICAgICBpZiAodHlwZSA9PT0gJ0lFTkQnKSB7XG4gICAgICAgICAgICBpZiAoZW5kICE9PSBjb250ZW50cy5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignSU1BR0UgUE5HIFx1NTMwNVx1NTQyQlx1NjVFMFx1NkNENVx1ODlFM1x1OTFDQVx1NzY4NFx1OTg5RFx1NTkxNlx1NjU3MFx1NjM2RVx1MzAwMicpO1xuICAgICAgICAgICAgcmV0dXJuIHsgd2lkdGgsIGhlaWdodCwgbWV0YWRhdGEgfTtcbiAgICAgICAgfVxuICAgICAgICBvZmZzZXQgPSBlbmQ7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcignSU1BR0UgUE5HIFx1NjU3MFx1NjM2RVx1NEUwRFx1NUI4Q1x1NjU3NFx1MzAwMicpO1xufVxuXG4vKiogQ3JlYXRvciBzdXBwbGllcyBFbGVjdHJvbiBmb3Igbm9uLVBORyByYXN0ZXIgZGVjb2Rpbmc7IG5ldmVyIGNoYW5nZSBOb2RlIHNjYWxlLiAqL1xuZnVuY3Rpb24gZGVjb2RlVG9QbmcoY29udGVudHM6IEJ1ZmZlcik6IEJ1ZmZlciB7XG4gICAgdHJ5IHtcbiAgICAgICAgY29uc3QgeyBuYXRpdmVJbWFnZSB9ID0gcmVxdWlyZSgnZWxlY3Ryb24nKTtcbiAgICAgICAgY29uc3QgaW1hZ2UgPSBuYXRpdmVJbWFnZS5jcmVhdGVGcm9tQnVmZmVyKGNvbnRlbnRzKTtcbiAgICAgICAgaWYgKGltYWdlLmlzRW1wdHkoKSkgdGhyb3cgbmV3IEVycm9yKCdcdTY1RTBcdTZDRDVcdThCQzZcdTUyMkJcdTU2RkVcdTcyNDdcdTY4M0NcdTVGMEYnKTtcbiAgICAgICAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0IH0gPSBpbWFnZS5nZXRTaXplKCk7XG4gICAgICAgIGRpbWVuc2lvbnMod2lkdGgsIGhlaWdodCk7XG4gICAgICAgIHJldHVybiBpbWFnZS50b1BORygpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgXHU2NUUwXHU2Q0Q1XHU4OUUzXHU3ODAxIElNQUdFIFx1NkU5MFx1NTZGRVx1NzI0N1x1RkYxQSR7KGVycm9yIGFzIEVycm9yKS5tZXNzYWdlfWApO1xuICAgIH1cbn1cblxuaW50ZXJmYWNlIFNhbXBsZSB7IGluZGV4OiBudW1iZXI7IHdlaWdodDogbnVtYmVyOyB9XG5cbi8qKiBUcmFuc3BhcmVudCBjb3ZlcmFnZSBvdXRzaWRlIEZJVCBib3VuZHM7IGNsYW1wLCBuZXZlciB3cmFwLCBhdCBpbWFnZSBlZGdlcy4gKi9cbmZ1bmN0aW9uIHNhbXBsZXMoc291cmNlOiBudW1iZXIsIHRhcmdldDogbnVtYmVyLCByYXRpbzogbnVtYmVyLCBvZmZzZXQ6IG51bWJlcik6IFNhbXBsZVtdW10ge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHsgbGVuZ3RoOiB0YXJnZXQgfSwgKF8sIG91dCkgPT4ge1xuICAgICAgICBpZiAocmF0aW8gPD0gMSkge1xuICAgICAgICAgICAgLy8gQXJlYSBmaWx0ZXJpbmcgcHJlc2VydmVzIGNvdmVyYWdlIGFuZCBzbWFsbCBkZXRhaWwgb24gcmVkdWN0aW9uLlxuICAgICAgICAgICAgY29uc3Qgc3RhcnQgPSAob3V0IC0gb2Zmc2V0KSAvIHJhdGlvLCBlbmQgPSAob3V0ICsgMSAtIG9mZnNldCkgLyByYXRpbztcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdDogU2FtcGxlW10gPSBbXTtcbiAgICAgICAgICAgIGNvbnN0IGZpcnN0ID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihzdGFydCkpO1xuICAgICAgICAgICAgY29uc3QgbGFzdCA9IE1hdGgubWluKHNvdXJjZSwgTWF0aC5jZWlsKGVuZCkpO1xuICAgICAgICAgICAgZm9yIChsZXQgaW5kZXggPSBmaXJzdDsgaW5kZXggPCBsYXN0OyBpbmRleCsrKSB7XG4gICAgICAgICAgICAgICAgY29uc3Qgd2VpZ2h0ID0gKE1hdGgubWluKGVuZCwgaW5kZXggKyAxKSAtIE1hdGgubWF4KHN0YXJ0LCBpbmRleCkpIC8gKGVuZCAtIHN0YXJ0KTtcbiAgICAgICAgICAgICAgICBpZiAod2VpZ2h0ID4gMCkgcmVzdWx0LnB1c2goeyBpbmRleCwgd2VpZ2h0IH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBjb3ZlcmFnZSA9IE1hdGgubWF4KDAsIE1hdGgubWluKG91dCArIDEsIG9mZnNldCArIHNvdXJjZSAqIHJhdGlvKSAtIE1hdGgubWF4KG91dCwgb2Zmc2V0KSk7XG4gICAgICAgIGlmICghY292ZXJhZ2UpIHJldHVybiBbXTtcbiAgICAgICAgY29uc3QgY2VudGVyID0gKG91dCArIDAuNSAtIG9mZnNldCkgLyByYXRpbyAtIDAuNTtcbiAgICAgICAgY29uc3QgZmlyc3QgPSBNYXRoLmZsb29yKGNlbnRlciksIGZyYWN0aW9uID0gY2VudGVyIC0gZmlyc3Q7XG4gICAgICAgIGNvbnN0IGNsYW1wID0gKGluZGV4OiBudW1iZXIpID0+IE1hdGgubWF4KDAsIE1hdGgubWluKHNvdXJjZSAtIDEsIGluZGV4KSk7XG4gICAgICAgIHJldHVybiBbeyBpbmRleDogY2xhbXAoZmlyc3QpLCB3ZWlnaHQ6ICgxIC0gZnJhY3Rpb24pICogY292ZXJhZ2UgfSxcbiAgICAgICAgICAgIHsgaW5kZXg6IGNsYW1wKGZpcnN0ICsgMSksIHdlaWdodDogZnJhY3Rpb24gKiBjb3ZlcmFnZSB9XTtcbiAgICB9KTtcbn1cblxuLyoqIFN0YW5kYXJkIGNlbnRlci1hbGlnbmVkIEZpZ21hIElNQUdFIEZJTEwvRklUIHdpdGggbm8gaW1hZ2VUcmFuc2Zvcm0vcm90YXRpb24uXG4gKiB3aWR0aC9oZWlnaHQgYXJlIG5vZGUgbG9naWNhbCB1bml0czsgc2NhbGUgaXMgYXBwbGllZCBleGFjdGx5IG9uY2UgdG8gdGhlIFBOR1xuICogY2FudmFzLiBWaXNpYmlsaXR5IGFuZCBub2RlL2FuY2VzdG9yIG9wYWNpdHkgZG8gbm90IGFmZmVjdCB0aGVzZSBzb3VyY2UgcGl4ZWxzLlxuICogUmV0dXJucyBhIGNvbXBsZXRlIFBORyBvciB0aHJvd3M7IG9yaWdpbmFsIGRvd25sb2FkZWQgYnl0ZXMgcmVtYWluIHVuY2hhbmdlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJhc3Rlcml6ZUltYWdlRmlsbChjb250ZW50czogQnVmZmVyLCBtb2RlOiAnRklMTCcgfCAnRklUJyxcbiAgICB3aWR0aDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlciwgc2NhbGU6IG51bWJlcik6IEJ1ZmZlciB7XG4gICAgaWYgKG1vZGUgIT09ICdGSUxMJyAmJiBtb2RlICE9PSAnRklUJykgdGhyb3cgbmV3IEVycm9yKCdJTUFHRSBcdTU4NkJcdTUxNDVcdTRFQzVcdTY1MkZcdTYzMDFcdTY4MDdcdTUxQzZcdTRFMkRcdTVGQzMgRklMTC9GSVRcdTMwMDInKTtcbiAgICBpZiAoIVt3aWR0aCwgaGVpZ2h0LCBzY2FsZV0uZXZlcnkoKHZhbHVlKSA9PiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpICYmIHZhbHVlID4gMCkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdJTUFHRSBcdTU4NkJcdTUxNDVcdTVCQkRcdTlBRDhcdTU0OENcdTUwMERcdTczODdcdTVGQzVcdTk4N0JcdTRFM0FcdTY3MDlcdTk2NTBcdTZCNjNcdTY1NzBcdTMwMDInKTtcbiAgICB9XG4gICAgY29uc3QgdGFyZ2V0V2lkdGggPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKHdpZHRoICogc2NhbGUpKTtcbiAgICBjb25zdCB0YXJnZXRIZWlnaHQgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGhlaWdodCAqIHNjYWxlKSk7XG4gICAgZGltZW5zaW9ucyh0YXJnZXRXaWR0aCwgdGFyZ2V0SGVpZ2h0KTtcbiAgICBpZiAoIWNvbnRlbnRzLmxlbmd0aCB8fCBjb250ZW50cy5sZW5ndGggPiBNQVhfQllURVMpIHRocm93IG5ldyBFcnJvcignSU1BR0UgXHU2RTkwXHU1NkZFXHU3MjQ3XHU0RTNBXHU3QTdBXHU2MjE2XHU4RDg1XHU4RkM3IDY0IE1CXHUzMDAyJyk7XG4gICAgY29uc3QgcG5nID0gY29udGVudHMuc3ViYXJyYXkoMCwgOCkuZXF1YWxzKFNJR05BVFVSRSkgPyBjb250ZW50cyA6IGRlY29kZVRvUG5nKGNvbnRlbnRzKTtcbiAgICBjb25zdCBoZWFkZXIgPSBpbnNwZWN0KHBuZyk7XG4gICAgY29uc3QgaW5wdXQgPSBQTkcuc3luYy5yZWFkKHBuZywgeyBjaGVja0NSQzogdHJ1ZSB9KTtcbiAgICBpZiAodGFyZ2V0V2lkdGggPT09IGhlYWRlci53aWR0aCAmJiB0YXJnZXRIZWlnaHQgPT09IGhlYWRlci5oZWlnaHQpIHJldHVybiBwbmc7XG4gICAgY29uc3QgcmF0aW8gPSBtb2RlID09PSAnRklMTCdcbiAgICAgICAgPyBNYXRoLm1heCh0YXJnZXRXaWR0aCAvIGhlYWRlci53aWR0aCwgdGFyZ2V0SGVpZ2h0IC8gaGVhZGVyLmhlaWdodClcbiAgICAgICAgOiBNYXRoLm1pbih0YXJnZXRXaWR0aCAvIGhlYWRlci53aWR0aCwgdGFyZ2V0SGVpZ2h0IC8gaGVhZGVyLmhlaWdodCk7XG4gICAgY29uc3Qgb2Zmc2V0WCA9ICh0YXJnZXRXaWR0aCAtIGhlYWRlci53aWR0aCAqIHJhdGlvKSAvIDI7XG4gICAgY29uc3Qgb2Zmc2V0WSA9ICh0YXJnZXRIZWlnaHQgLSBoZWFkZXIuaGVpZ2h0ICogcmF0aW8pIC8gMjtcbiAgICBjb25zdCB4cyA9IHNhbXBsZXMoaGVhZGVyLndpZHRoLCB0YXJnZXRXaWR0aCwgcmF0aW8sIG9mZnNldFgpO1xuICAgIGNvbnN0IHlzID0gc2FtcGxlcyhoZWFkZXIuaGVpZ2h0LCB0YXJnZXRIZWlnaHQsIHJhdGlvLCBvZmZzZXRZKTtcbiAgICBjb25zdCBvdXRwdXQgPSBuZXcgUE5HKHsgd2lkdGg6IHRhcmdldFdpZHRoLCBoZWlnaHQ6IHRhcmdldEhlaWdodCB9KTtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IHRhcmdldEhlaWdodDsgeSsrKSB7XG4gICAgICAgIGlmICgheXNbeV0ubGVuZ3RoKSBjb250aW51ZTtcbiAgICAgICAgZm9yIChsZXQgeCA9IDA7IHggPCB0YXJnZXRXaWR0aDsgeCsrKSB7XG4gICAgICAgICAgICBsZXQgYWxwaGEgPSAwLCByZWQgPSAwLCBncmVlbiA9IDAsIGJsdWUgPSAwO1xuICAgICAgICAgICAgZm9yIChjb25zdCBzeSBvZiB5c1t5XSkgZm9yIChjb25zdCBzeCBvZiB4c1t4XSkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IChzeS5pbmRleCAqIGhlYWRlci53aWR0aCArIHN4LmluZGV4KSAqIDQ7XG4gICAgICAgICAgICAgICAgY29uc3QgYSA9IGlucHV0LmRhdGFbc291cmNlICsgM10gKiBzeS53ZWlnaHQgKiBzeC53ZWlnaHQ7XG4gICAgICAgICAgICAgICAgYWxwaGEgKz0gYTtcbiAgICAgICAgICAgICAgICByZWQgKz0gaW5wdXQuZGF0YVtzb3VyY2VdICogYTtcbiAgICAgICAgICAgICAgICBncmVlbiArPSBpbnB1dC5kYXRhW3NvdXJjZSArIDFdICogYTtcbiAgICAgICAgICAgICAgICBibHVlICs9IGlucHV0LmRhdGFbc291cmNlICsgMl0gKiBhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgdGFyZ2V0ID0gKHkgKiB0YXJnZXRXaWR0aCArIHgpICogNDtcbiAgICAgICAgICAgIG91dHB1dC5kYXRhW3RhcmdldCArIDNdID0gTWF0aC5yb3VuZChhbHBoYSk7XG4gICAgICAgICAgICAvLyBJZ25vcmUgaGlkZGVuIFJHQiBhbmQgZG8gbm90IGRhcmtlbiBzZW1pLXRyYW5zcGFyZW50IGZyaW5nZXMuXG4gICAgICAgICAgICBpZiAob3V0cHV0LmRhdGFbdGFyZ2V0ICsgM10gPiAwKSB7XG4gICAgICAgICAgICAgICAgb3V0cHV0LmRhdGFbdGFyZ2V0XSA9IE1hdGgucm91bmQocmVkIC8gYWxwaGEpO1xuICAgICAgICAgICAgICAgIG91dHB1dC5kYXRhW3RhcmdldCArIDFdID0gTWF0aC5yb3VuZChncmVlbiAvIGFscGhhKTtcbiAgICAgICAgICAgICAgICBvdXRwdXQuZGF0YVt0YXJnZXQgKyAyXSA9IE1hdGgucm91bmQoYmx1ZSAvIGFscGhhKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBlbmNvZGVkID0gUE5HLnN5bmMud3JpdGUob3V0cHV0KTtcbiAgICByZXR1cm4gaGVhZGVyLm1ldGFkYXRhLmxlbmd0aFxuICAgICAgICA/IEJ1ZmZlci5jb25jYXQoW2VuY29kZWQuc3ViYXJyYXkoMCwgMzMpLCAuLi5oZWFkZXIubWV0YWRhdGEsIGVuY29kZWQuc3ViYXJyYXkoMzMpXSkgOiBlbmNvZGVkO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUE7QUFBQSwwQ0FBQUEsVUFBQUMsU0FBQTtBQUFB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O0FBQUEsSUFDSjtBQUFBLEVBQ0o7QUFDQSxRQUFNLFVBQVUsaUJBQUksS0FBSyxNQUFNLE1BQU07QUFDckMsU0FBTyxPQUFPLFNBQVMsU0FDakIsT0FBTyxPQUFPLENBQUMsUUFBUSxTQUFTLEdBQUcsRUFBRSxHQUFHLEdBQUcsT0FBTyxVQUFVLFFBQVEsU0FBUyxFQUFFLENBQUMsQ0FBQyxJQUFJO0FBQy9GOyIsCiAgIm5hbWVzIjogWyJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJpbmZsYXRlZERhdGEiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIlBORyIsICJmaXJzdCJdCn0K
