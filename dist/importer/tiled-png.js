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

// source/importer/tiled-png.ts
var tiled_png_exports = {};
__export(tiled_png_exports, {
  pixelSizedTileAsset: () => pixelSizedTileAsset,
  rasterizeTile: () => rasterizeTile,
  tiledRasterKey: () => tiledRasterKey
});
module.exports = __toCommonJS(tiled_png_exports);
var import_pngjs = __toESM(require_png());
var SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var MAX_PIXELS = 16 * 1024 * 1024;
var MAX_BYTES = 64 * 1024 * 1024;
var COLOR_CHUNKS = /* @__PURE__ */ new Set(["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"]);
function tiledRasterKey(sourceKey, requestedScale) {
  positiveScale(requestedScale);
  return JSON.stringify({ sourceKey, sizing: "figma-visible-pixels-v1", requestedScale });
}
function pixelSizedTileAsset(asset) {
  return { ...asset, tiled: true, sliced: false, tileScale: 1 };
}
function positiveScale(value) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("\u5E73\u94FA\u8D44\u6E90\u500D\u7387\u5FC5\u987B\u4E3A\u6B63\u6570\u3002");
}
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > MAX_PIXELS) {
    throw new Error("\u5E73\u94FA\u8D44\u6E90\u5C3A\u5BF8\u8D85\u8FC7\u5B89\u5168\u5904\u7406\u8303\u56F4\uFF08\u5355\u8FB9 8192\uFF0C\u5408\u8BA1 1600 \u4E07\u50CF\u7D20\uFF09\u3002");
  }
}
function inspect(contents) {
  if (contents.length < 45 || contents.length > MAX_BYTES || !contents.subarray(0, 8).equals(SIGNATURE) || contents.readUInt32BE(8) !== 13 || contents.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("\u5E73\u94FA\u56FE\u7247\u4E0D\u662F\u6709\u6548\u7684 PNG\u3002");
  }
  const width = contents.readUInt32BE(16), height = contents.readUInt32BE(20);
  dimensions(width, height);
  if (contents[24] > 8) throw new Error("\u6682\u4E0D\u652F\u6301\u91CD\u91C7\u6837\u9AD8\u4F4D\u6DF1\u5E73\u94FA\u56FE\u7247\u3002");
  const metadata = [];
  for (let offset = 8; offset + 12 <= contents.length; ) {
    const end = offset + 12 + contents.readUInt32BE(offset);
    if (end > contents.length) break;
    const type = contents.toString("ascii", offset + 4, offset + 8);
    if (["acTL", "fcTL", "fdAT", "sBIT"].includes(type)) throw new Error("\u6682\u4E0D\u652F\u6301\u91CD\u91C7\u6837\u52A8\u753B\u6216\u7279\u6B8A\u4F4D\u6DF1\u5E73\u94FA\u56FE\u7247\u3002");
    if (COLOR_CHUNKS.has(type)) metadata.push(contents.subarray(offset, end));
    if (type === "IEND") return { width, height, metadata };
    offset = end;
  }
  throw new Error("\u5E73\u94FA PNG \u6570\u636E\u4E0D\u5B8C\u6574\u3002");
}
function decodeToPng(contents) {
  const { nativeImage } = require("electron");
  const image = nativeImage.createFromBuffer(contents);
  if (image.isEmpty()) throw new Error("\u65E0\u6CD5\u89E3\u7801\u5E73\u94FA\u6E90\u56FE\u7247\u3002");
  const { width, height } = image.getSize();
  dimensions(width, height);
  return image.toPNG();
}
function samples(source, target) {
  const ratio = source / target;
  return Array.from({ length: target }, (_, out) => {
    if (ratio >= 1) {
      const start = out * ratio, end = (out + 1) * ratio;
      const result = [];
      for (let i = Math.floor(start); i < Math.ceil(end); i++) {
        const weight = (Math.min(end, i + 1) - Math.max(start, i)) / ratio;
        if (weight > 0) result.push({ index: Math.min(source - 1, i), weight });
      }
      return result;
    }
    const center = (out + 0.5) * ratio - 0.5;
    const left = Math.floor(center), fraction = center - left;
    return [
      { index: (left + source) % source, weight: 1 - fraction },
      { index: (left + 1) % source, weight: fraction }
    ];
  });
}
function rasterizeTile(contents, requestedScale, sourceRenderScale = 1, decode = decodeToPng) {
  positiveScale(requestedScale);
  positiveScale(sourceRenderScale);
  if (!contents.length || contents.length > MAX_BYTES) throw new Error("\u5E73\u94FA\u6E90\u56FE\u7247\u4E3A\u7A7A\u6216\u8D85\u8FC7 64 MB\u3002");
  const png = contents.subarray(0, 8).equals(SIGNATURE) ? contents : decode(contents);
  const header = inspect(png);
  const desiredWidth = header.width * requestedScale / sourceRenderScale;
  const desiredHeight = header.height * requestedScale / sourceRenderScale;
  const width = Math.max(1, Math.round(desiredWidth)), height = Math.max(1, Math.round(desiredHeight));
  dimensions(width, height);
  const info = {
    sourceWidth: header.width,
    sourceHeight: header.height,
    width,
    height,
    rounded: Math.abs(width - desiredWidth) > 1e-6 || Math.abs(height - desiredHeight) > 1e-6
  };
  const input = import_pngjs.PNG.sync.read(png, { checkCRC: true });
  if (width === header.width && height === header.height) return { ...info, contents: png };
  const output = new import_pngjs.PNG({ width, height });
  const xs = samples(header.width, width), ys = samples(header.height, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let alpha = 0, red = 0, green = 0, blue = 0;
    for (const sy of ys[y]) for (const sx of xs[x]) {
      const pos2 = (sy.index * header.width + sx.index) * 4;
      const a = input.data[pos2 + 3] * sy.weight * sx.weight;
      alpha += a;
      red += input.data[pos2] * a;
      green += input.data[pos2 + 1] * a;
      blue += input.data[pos2 + 2] * a;
    }
    const pos = (y * width + x) * 4;
    output.data[pos + 3] = Math.round(alpha);
    if (alpha > 0) {
      output.data[pos] = Math.round(red / alpha);
      output.data[pos + 1] = Math.round(green / alpha);
      output.data[pos + 2] = Math.round(blue / alpha);
    }
  }
  const encoded = import_pngjs.PNG.sync.write(output);
  return { ...info, contents: header.metadata.length ? Buffer.concat([encoded.subarray(0, 33), ...header.metadata, encoded.subarray(33)]) : encoded };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  pixelSizedTileAsset,
  rasterizeTile,
  tiledRasterKey
});
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9jaHVua3N0cmVhbS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ludGVybGFjZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhZXRoLXByZWRpY3Rvci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1hc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NvbnN0YW50cy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2NyYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BhcnNlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2JpdG1hcHBlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2Zvcm1hdC1ub3JtYWxpc2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLWFzeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvYml0cGFja2VyLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvZmlsdGVyLXBhY2suanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXIuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItYXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLWluZmxhdGUuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9zeW5jLXJlYWRlci5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL2ZpbHRlci1wYXJzZS1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcGFyc2VyLXN5bmMuanMiLCAiLi4vLi4vbm9kZV9tb2R1bGVzL3BuZ2pzL2xpYi9wYWNrZXItc3luYy5qcyIsICIuLi8uLi9ub2RlX21vZHVsZXMvcG5nanMvbGliL3BuZy1zeW5jLmpzIiwgIi4uLy4uL25vZGVfbW9kdWxlcy9wbmdqcy9saWIvcG5nLmpzIiwgIi4uLy4uL3NvdXJjZS9pbXBvcnRlci90aWxlZC1wbmcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgdXRpbCA9IHJlcXVpcmUoXCJ1dGlsXCIpO1xubGV0IFN0cmVhbSA9IHJlcXVpcmUoXCJzdHJlYW1cIik7XG5cbmxldCBDaHVua1N0cmVhbSA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uICgpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgdGhpcy5fYnVmZmVycyA9IFtdO1xuICB0aGlzLl9idWZmZXJlZCA9IDA7XG5cbiAgdGhpcy5fcmVhZHMgPSBbXTtcbiAgdGhpcy5fcGF1c2VkID0gZmFsc2U7XG5cbiAgdGhpcy5fZW5jb2RpbmcgPSBcInV0ZjhcIjtcbiAgdGhpcy53cml0YWJsZSA9IHRydWU7XG59KTtcbnV0aWwuaW5oZXJpdHMoQ2h1bmtTdHJlYW0sIFN0cmVhbSk7XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5yZWFkID0gZnVuY3Rpb24gKGxlbmd0aCwgY2FsbGJhY2spIHtcbiAgdGhpcy5fcmVhZHMucHVzaCh7XG4gICAgbGVuZ3RoOiBNYXRoLmFicyhsZW5ndGgpLCAvLyBpZiBsZW5ndGggPCAwIHRoZW4gYXQgbW9zdCB0aGlzIGxlbmd0aFxuICAgIGFsbG93TGVzczogbGVuZ3RoIDwgMCxcbiAgICBmdW5jOiBjYWxsYmFjayxcbiAgfSk7XG5cbiAgcHJvY2Vzcy5uZXh0VGljayhcbiAgICBmdW5jdGlvbiAoKSB7XG4gICAgICB0aGlzLl9wcm9jZXNzKCk7XG5cbiAgICAgIC8vIGl0cyBwYXVzZWQgYW5kIHRoZXJlIGlzIG5vdCBlbm91Z2h0IGRhdGEgdGhlbiBhc2sgZm9yIG1vcmVcbiAgICAgIGlmICh0aGlzLl9wYXVzZWQgJiYgdGhpcy5fcmVhZHMgJiYgdGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgICAgICB0aGlzLl9wYXVzZWQgPSBmYWxzZTtcblxuICAgICAgICB0aGlzLmVtaXQoXCJkcmFpblwiKTtcbiAgICAgIH1cbiAgICB9LmJpbmQodGhpcylcbiAgKTtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhLCBlbmNvZGluZykge1xuICBpZiAoIXRoaXMud3JpdGFibGUpIHtcbiAgICB0aGlzLmVtaXQoXCJlcnJvclwiLCBuZXcgRXJyb3IoXCJTdHJlYW0gbm90IHdyaXRhYmxlXCIpKTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICBsZXQgZGF0YUJ1ZmZlcjtcbiAgaWYgKEJ1ZmZlci5pc0J1ZmZlcihkYXRhKSkge1xuICAgIGRhdGFCdWZmZXIgPSBkYXRhO1xuICB9IGVsc2Uge1xuICAgIGRhdGFCdWZmZXIgPSBCdWZmZXIuZnJvbShkYXRhLCBlbmNvZGluZyB8fCB0aGlzLl9lbmNvZGluZyk7XG4gIH1cblxuICB0aGlzLl9idWZmZXJzLnB1c2goZGF0YUJ1ZmZlcik7XG4gIHRoaXMuX2J1ZmZlcmVkICs9IGRhdGFCdWZmZXIubGVuZ3RoO1xuXG4gIHRoaXMuX3Byb2Nlc3MoKTtcblxuICAvLyBvayBpZiB0aGVyZSBhcmUgbm8gbW9yZSByZWFkIHJlcXVlc3RzXG4gIGlmICh0aGlzLl9yZWFkcyAmJiB0aGlzLl9yZWFkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aGlzLl9wYXVzZWQgPSB0cnVlO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMud3JpdGFibGUgJiYgIXRoaXMuX3BhdXNlZDtcbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5lbmQgPSBmdW5jdGlvbiAoZGF0YSwgZW5jb2RpbmcpIHtcbiAgaWYgKGRhdGEpIHtcbiAgICB0aGlzLndyaXRlKGRhdGEsIGVuY29kaW5nKTtcbiAgfVxuXG4gIHRoaXMud3JpdGFibGUgPSBmYWxzZTtcblxuICAvLyBhbHJlYWR5IGRlc3Ryb3llZFxuICBpZiAoIXRoaXMuX2J1ZmZlcnMpIHtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBlbnF1ZXVlIG9yIGhhbmRsZSBlbmRcbiAgaWYgKHRoaXMuX2J1ZmZlcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhpcy5fZW5kKCk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fYnVmZmVycy5wdXNoKG51bGwpO1xuICAgIHRoaXMuX3Byb2Nlc3MoKTtcbiAgfVxufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmRlc3Ryb3lTb29uID0gQ2h1bmtTdHJlYW0ucHJvdG90eXBlLmVuZDtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9lbmQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLl9yZWFkcy5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgbmV3IEVycm9yKFwiVW5leHBlY3RlZCBlbmQgb2YgaW5wdXRcIikpO1xuICB9XG5cbiAgdGhpcy5kZXN0cm95KCk7XG59O1xuXG5DaHVua1N0cmVhbS5wcm90b3R5cGUuZGVzdHJveSA9IGZ1bmN0aW9uICgpIHtcbiAgaWYgKCF0aGlzLl9idWZmZXJzKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy53cml0YWJsZSA9IGZhbHNlO1xuICB0aGlzLl9yZWFkcyA9IG51bGw7XG4gIHRoaXMuX2J1ZmZlcnMgPSBudWxsO1xuXG4gIHRoaXMuZW1pdChcImNsb3NlXCIpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9wcm9jZXNzUmVhZEFsbG93aW5nTGVzcyA9IGZ1bmN0aW9uIChyZWFkKSB7XG4gIC8vIG9rIHRoZXJlIGlzIGFueSBkYXRhIHNvIHRoYXQgd2UgY2FuIHNhdGlzZnkgdGhpcyByZXF1ZXN0XG4gIHRoaXMuX3JlYWRzLnNoaWZ0KCk7IC8vID09IHJlYWRcblxuICAvLyBmaXJzdCB3ZSBuZWVkIHRvIHBlZWsgaW50byBmaXJzdCBidWZmZXJcbiAgbGV0IHNtYWxsZXJCdWYgPSB0aGlzLl9idWZmZXJzWzBdO1xuXG4gIC8vIG9rIHRoZXJlIGlzIG1vcmUgZGF0YSB0aGFuIHdlIG5lZWRcbiAgaWYgKHNtYWxsZXJCdWYubGVuZ3RoID4gcmVhZC5sZW5ndGgpIHtcbiAgICB0aGlzLl9idWZmZXJlZCAtPSByZWFkLmxlbmd0aDtcbiAgICB0aGlzLl9idWZmZXJzWzBdID0gc21hbGxlckJ1Zi5zbGljZShyZWFkLmxlbmd0aCk7XG5cbiAgICByZWFkLmZ1bmMuY2FsbCh0aGlzLCBzbWFsbGVyQnVmLnNsaWNlKDAsIHJlYWQubGVuZ3RoKSk7XG4gIH0gZWxzZSB7XG4gICAgLy8gb2sgdGhpcyBpcyBsZXNzIHRoYW4gbWF4aW11bSBsZW5ndGggc28gdXNlIGl0IGFsbFxuICAgIHRoaXMuX2J1ZmZlcmVkIC09IHNtYWxsZXJCdWYubGVuZ3RoO1xuICAgIHRoaXMuX2J1ZmZlcnMuc2hpZnQoKTsgLy8gPT0gc21hbGxlckJ1ZlxuXG4gICAgcmVhZC5mdW5jLmNhbGwodGhpcywgc21hbGxlckJ1Zik7XG4gIH1cbn07XG5cbkNodW5rU3RyZWFtLnByb3RvdHlwZS5fcHJvY2Vzc1JlYWQgPSBmdW5jdGlvbiAocmVhZCkge1xuICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgbGV0IHBvcyA9IDA7XG4gIGxldCBjb3VudCA9IDA7XG4gIGxldCBkYXRhID0gQnVmZmVyLmFsbG9jKHJlYWQubGVuZ3RoKTtcblxuICAvLyBjcmVhdGUgYnVmZmVyIGZvciBhbGwgZGF0YVxuICB3aGlsZSAocG9zIDwgcmVhZC5sZW5ndGgpIHtcbiAgICBsZXQgYnVmID0gdGhpcy5fYnVmZmVyc1tjb3VudCsrXTtcbiAgICBsZXQgbGVuID0gTWF0aC5taW4oYnVmLmxlbmd0aCwgcmVhZC5sZW5ndGggLSBwb3MpO1xuXG4gICAgYnVmLmNvcHkoZGF0YSwgcG9zLCAwLCBsZW4pO1xuICAgIHBvcyArPSBsZW47XG5cbiAgICAvLyBsYXN0IGJ1ZmZlciB3YXNuJ3QgdXNlZCBhbGwgc28ganVzdCBzbGljZSBpdCBhbmQgbGVhdmVcbiAgICBpZiAobGVuICE9PSBidWYubGVuZ3RoKSB7XG4gICAgICB0aGlzLl9idWZmZXJzWy0tY291bnRdID0gYnVmLnNsaWNlKGxlbik7XG4gICAgfVxuICB9XG5cbiAgLy8gcmVtb3ZlIGFsbCB1c2VkIGJ1ZmZlcnNcbiAgaWYgKGNvdW50ID4gMCkge1xuICAgIHRoaXMuX2J1ZmZlcnMuc3BsaWNlKDAsIGNvdW50KTtcbiAgfVxuXG4gIHRoaXMuX2J1ZmZlcmVkIC09IHJlYWQubGVuZ3RoO1xuXG4gIHJlYWQuZnVuYy5jYWxsKHRoaXMsIGRhdGEpO1xufTtcblxuQ2h1bmtTdHJlYW0ucHJvdG90eXBlLl9wcm9jZXNzID0gZnVuY3Rpb24gKCkge1xuICB0cnkge1xuICAgIC8vIGFzIGxvbmcgYXMgdGhlcmUgaXMgYW55IGRhdGEgYW5kIHJlYWQgcmVxdWVzdHNcbiAgICB3aGlsZSAodGhpcy5fYnVmZmVyZWQgPiAwICYmIHRoaXMuX3JlYWRzICYmIHRoaXMuX3JlYWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGxldCByZWFkID0gdGhpcy5fcmVhZHNbMF07XG5cbiAgICAgIC8vIHJlYWQgYW55IGRhdGEgKGJ1dCBubyBtb3JlIHRoYW4gbGVuZ3RoKVxuICAgICAgaWYgKHJlYWQuYWxsb3dMZXNzKSB7XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NSZWFkQWxsb3dpbmdMZXNzKHJlYWQpO1xuICAgICAgfSBlbHNlIGlmICh0aGlzLl9idWZmZXJlZCA+PSByZWFkLmxlbmd0aCkge1xuICAgICAgICAvLyBvayB3ZSBjYW4gbWVldCBzb21lIGV4cGVjdGF0aW9uc1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NSZWFkKHJlYWQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gbm90IGVub3VnaHQgZGF0YSB0byBzYXRpc2Z5IGZpcnN0IHJlcXVlc3QgaW4gcXVldWVcbiAgICAgICAgLy8gc28gd2UgbmVlZCB0byB3YWl0IGZvciBtb3JlXG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICh0aGlzLl9idWZmZXJzICYmICF0aGlzLndyaXRhYmxlKSB7XG4gICAgICB0aGlzLl9lbmQoKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGV4KSB7XG4gICAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgZXgpO1xuICB9XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG4vLyBBZGFtIDdcbi8vICAgMCAxIDIgMyA0IDUgNiA3XG4vLyAwIHggNiA0IDYgeCA2IDQgNlxuLy8gMSA3IDcgNyA3IDcgNyA3IDdcbi8vIDIgNSA2IDUgNiA1IDYgNSA2XG4vLyAzIDcgNyA3IDcgNyA3IDcgN1xuLy8gNCAzIDYgNCA2IDMgNiA0IDZcbi8vIDUgNyA3IDcgNyA3IDcgNyA3XG4vLyA2IDUgNiA1IDYgNSA2IDUgNlxuLy8gNyA3IDcgNyA3IDcgNyA3IDdcblxubGV0IGltYWdlUGFzc2VzID0gW1xuICB7XG4gICAgLy8gcGFzcyAxIC0gMXB4XG4gICAgeDogWzBdLFxuICAgIHk6IFswXSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgMiAtIDFweFxuICAgIHg6IFs0XSxcbiAgICB5OiBbMF0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDMgLSAycHhcbiAgICB4OiBbMCwgNF0sXG4gICAgeTogWzRdLFxuICB9LFxuICB7XG4gICAgLy8gcGFzcyA0IC0gNHB4XG4gICAgeDogWzIsIDZdLFxuICAgIHk6IFswLCA0XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNSAtIDhweFxuICAgIHg6IFswLCAyLCA0LCA2XSxcbiAgICB5OiBbMiwgNl0sXG4gIH0sXG4gIHtcbiAgICAvLyBwYXNzIDYgLSAxNnB4XG4gICAgeDogWzEsIDMsIDUsIDddLFxuICAgIHk6IFswLCAyLCA0LCA2XSxcbiAgfSxcbiAge1xuICAgIC8vIHBhc3MgNyAtIDMycHhcbiAgICB4OiBbMCwgMSwgMiwgMywgNCwgNSwgNiwgN10sXG4gICAgeTogWzEsIDMsIDUsIDddLFxuICB9LFxuXTtcblxuZXhwb3J0cy5nZXRJbWFnZVBhc3NlcyA9IGZ1bmN0aW9uICh3aWR0aCwgaGVpZ2h0KSB7XG4gIGxldCBpbWFnZXMgPSBbXTtcbiAgbGV0IHhMZWZ0T3ZlciA9IHdpZHRoICUgODtcbiAgbGV0IHlMZWZ0T3ZlciA9IGhlaWdodCAlIDg7XG4gIGxldCB4UmVwZWF0cyA9ICh3aWR0aCAtIHhMZWZ0T3ZlcikgLyA4O1xuICBsZXQgeVJlcGVhdHMgPSAoaGVpZ2h0IC0geUxlZnRPdmVyKSAvIDg7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgaW1hZ2VQYXNzZXMubGVuZ3RoOyBpKyspIHtcbiAgICBsZXQgcGFzcyA9IGltYWdlUGFzc2VzW2ldO1xuICAgIGxldCBwYXNzV2lkdGggPSB4UmVwZWF0cyAqIHBhc3MueC5sZW5ndGg7XG4gICAgbGV0IHBhc3NIZWlnaHQgPSB5UmVwZWF0cyAqIHBhc3MueS5sZW5ndGg7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXNzLngubGVuZ3RoOyBqKyspIHtcbiAgICAgIGlmIChwYXNzLnhbal0gPCB4TGVmdE92ZXIpIHtcbiAgICAgICAgcGFzc1dpZHRoKys7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXNzLnkubGVuZ3RoOyBqKyspIHtcbiAgICAgIGlmIChwYXNzLnlbal0gPCB5TGVmdE92ZXIpIHtcbiAgICAgICAgcGFzc0hlaWdodCsrO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChwYXNzV2lkdGggPiAwICYmIHBhc3NIZWlnaHQgPiAwKSB7XG4gICAgICBpbWFnZXMucHVzaCh7IHdpZHRoOiBwYXNzV2lkdGgsIGhlaWdodDogcGFzc0hlaWdodCwgaW5kZXg6IGkgfSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBpbWFnZXM7XG59O1xuXG5leHBvcnRzLmdldEludGVybGFjZUl0ZXJhdG9yID0gZnVuY3Rpb24gKHdpZHRoKSB7XG4gIHJldHVybiBmdW5jdGlvbiAoeCwgeSwgcGFzcykge1xuICAgIGxldCBvdXRlclhMZWZ0T3ZlciA9IHggJSBpbWFnZVBhc3Nlc1twYXNzXS54Lmxlbmd0aDtcbiAgICBsZXQgb3V0ZXJYID1cbiAgICAgICgoeCAtIG91dGVyWExlZnRPdmVyKSAvIGltYWdlUGFzc2VzW3Bhc3NdLngubGVuZ3RoKSAqIDggK1xuICAgICAgaW1hZ2VQYXNzZXNbcGFzc10ueFtvdXRlclhMZWZ0T3Zlcl07XG4gICAgbGV0IG91dGVyWUxlZnRPdmVyID0geSAlIGltYWdlUGFzc2VzW3Bhc3NdLnkubGVuZ3RoO1xuICAgIGxldCBvdXRlclkgPVxuICAgICAgKCh5IC0gb3V0ZXJZTGVmdE92ZXIpIC8gaW1hZ2VQYXNzZXNbcGFzc10ueS5sZW5ndGgpICogOCArXG4gICAgICBpbWFnZVBhc3Nlc1twYXNzXS55W291dGVyWUxlZnRPdmVyXTtcbiAgICByZXR1cm4gb3V0ZXJYICogNCArIG91dGVyWSAqIHdpZHRoICogNDtcbiAgfTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gcGFldGhQcmVkaWN0b3IobGVmdCwgYWJvdmUsIHVwTGVmdCkge1xuICBsZXQgcGFldGggPSBsZWZ0ICsgYWJvdmUgLSB1cExlZnQ7XG4gIGxldCBwTGVmdCA9IE1hdGguYWJzKHBhZXRoIC0gbGVmdCk7XG4gIGxldCBwQWJvdmUgPSBNYXRoLmFicyhwYWV0aCAtIGFib3ZlKTtcbiAgbGV0IHBVcExlZnQgPSBNYXRoLmFicyhwYWV0aCAtIHVwTGVmdCk7XG5cbiAgaWYgKHBMZWZ0IDw9IHBBYm92ZSAmJiBwTGVmdCA8PSBwVXBMZWZ0KSB7XG4gICAgcmV0dXJuIGxlZnQ7XG4gIH1cbiAgaWYgKHBBYm92ZSA8PSBwVXBMZWZ0KSB7XG4gICAgcmV0dXJuIGFib3ZlO1xuICB9XG4gIHJldHVybiB1cExlZnQ7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaW50ZXJsYWNlVXRpbHMgPSByZXF1aXJlKFwiLi9pbnRlcmxhY2VcIik7XG5sZXQgcGFldGhQcmVkaWN0b3IgPSByZXF1aXJlKFwiLi9wYWV0aC1wcmVkaWN0b3JcIik7XG5cbmZ1bmN0aW9uIGdldEJ5dGVXaWR0aCh3aWR0aCwgYnBwLCBkZXB0aCkge1xuICBsZXQgYnl0ZVdpZHRoID0gd2lkdGggKiBicHA7XG4gIGlmIChkZXB0aCAhPT0gOCkge1xuICAgIGJ5dGVXaWR0aCA9IE1hdGguY2VpbChieXRlV2lkdGggLyAoOCAvIGRlcHRoKSk7XG4gIH1cbiAgcmV0dXJuIGJ5dGVXaWR0aDtcbn1cblxubGV0IEZpbHRlciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChiaXRtYXBJbmZvLCBkZXBlbmRlbmNpZXMpIHtcbiAgbGV0IHdpZHRoID0gYml0bWFwSW5mby53aWR0aDtcbiAgbGV0IGhlaWdodCA9IGJpdG1hcEluZm8uaGVpZ2h0O1xuICBsZXQgaW50ZXJsYWNlID0gYml0bWFwSW5mby5pbnRlcmxhY2U7XG4gIGxldCBicHAgPSBiaXRtYXBJbmZvLmJwcDtcbiAgbGV0IGRlcHRoID0gYml0bWFwSW5mby5kZXB0aDtcblxuICB0aGlzLnJlYWQgPSBkZXBlbmRlbmNpZXMucmVhZDtcbiAgdGhpcy53cml0ZSA9IGRlcGVuZGVuY2llcy53cml0ZTtcbiAgdGhpcy5jb21wbGV0ZSA9IGRlcGVuZGVuY2llcy5jb21wbGV0ZTtcblxuICB0aGlzLl9pbWFnZUluZGV4ID0gMDtcbiAgdGhpcy5faW1hZ2VzID0gW107XG4gIGlmIChpbnRlcmxhY2UpIHtcbiAgICBsZXQgcGFzc2VzID0gaW50ZXJsYWNlVXRpbHMuZ2V0SW1hZ2VQYXNzZXMod2lkdGgsIGhlaWdodCk7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXNzZXMubGVuZ3RoOyBpKyspIHtcbiAgICAgIHRoaXMuX2ltYWdlcy5wdXNoKHtcbiAgICAgICAgYnl0ZVdpZHRoOiBnZXRCeXRlV2lkdGgocGFzc2VzW2ldLndpZHRoLCBicHAsIGRlcHRoKSxcbiAgICAgICAgaGVpZ2h0OiBwYXNzZXNbaV0uaGVpZ2h0LFxuICAgICAgICBsaW5lSW5kZXg6IDAsXG4gICAgICB9KTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5faW1hZ2VzLnB1c2goe1xuICAgICAgYnl0ZVdpZHRoOiBnZXRCeXRlV2lkdGgod2lkdGgsIGJwcCwgZGVwdGgpLFxuICAgICAgaGVpZ2h0OiBoZWlnaHQsXG4gICAgICBsaW5lSW5kZXg6IDAsXG4gICAgfSk7XG4gIH1cblxuICAvLyB3aGVuIGZpbHRlcmluZyB0aGUgbGluZSB3ZSBsb29rIGF0IHRoZSBwaXhlbCB0byB0aGUgbGVmdFxuICAvLyB0aGUgc3BlYyBhbHNvIHNheXMgaXQgaXMgZG9uZSBvbiBhIGJ5dGUgbGV2ZWwgcmVnYXJkbGVzcyBvZiB0aGUgbnVtYmVyIG9mIHBpeGVsc1xuICAvLyBzbyBpZiB0aGUgZGVwdGggaXMgYnl0ZSBjb21wYXRpYmxlICg4IG9yIDE2KSB3ZSBzdWJ0cmFjdCB0aGUgYnBwIGluIG9yZGVyIHRvIGNvbXBhcmUgYmFja1xuICAvLyBhIHBpeGVsIHJhdGhlciB0aGFuIGp1c3QgYSBkaWZmZXJlbnQgYnl0ZSBwYXJ0LiBIb3dldmVyIGlmIHdlIGFyZSBzdWIgYnl0ZSwgd2UgaWdub3JlLlxuICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICB0aGlzLl94Q29tcGFyaXNvbiA9IGJwcDtcbiAgfSBlbHNlIGlmIChkZXB0aCA9PT0gMTYpIHtcbiAgICB0aGlzLl94Q29tcGFyaXNvbiA9IGJwcCAqIDI7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5feENvbXBhcmlzb24gPSAxO1xuICB9XG59KTtcblxuRmlsdGVyLnByb3RvdHlwZS5zdGFydCA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5yZWFkKFxuICAgIHRoaXMuX2ltYWdlc1t0aGlzLl9pbWFnZUluZGV4XS5ieXRlV2lkdGggKyAxLFxuICAgIHRoaXMuX3JldmVyc2VGaWx0ZXJMaW5lLmJpbmQodGhpcylcbiAgKTtcbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTEgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgeENvbXBhcmlzb24gPSB0aGlzLl94Q29tcGFyaXNvbjtcbiAgbGV0IHhCaWdnZXJUaGFuID0geENvbXBhcmlzb24gLSAxO1xuXG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgcmF3Qnl0ZSA9IHJhd0RhdGFbMSArIHhdO1xuICAgIGxldCBmMUxlZnQgPSB4ID4geEJpZ2dlclRoYW4gPyB1bmZpbHRlcmVkTGluZVt4IC0geENvbXBhcmlzb25dIDogMDtcbiAgICB1bmZpbHRlcmVkTGluZVt4XSA9IHJhd0J5dGUgKyBmMUxlZnQ7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTIgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgbGFzdExpbmUgPSB0aGlzLl9sYXN0TGluZTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjJVcCA9IGxhc3RMaW5lID8gbGFzdExpbmVbeF0gOiAwO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGYyVXA7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3VuRmlsdGVyVHlwZTMgPSBmdW5jdGlvbiAoXG4gIHJhd0RhdGEsXG4gIHVuZmlsdGVyZWRMaW5lLFxuICBieXRlV2lkdGhcbikge1xuICBsZXQgeENvbXBhcmlzb24gPSB0aGlzLl94Q29tcGFyaXNvbjtcbiAgbGV0IHhCaWdnZXJUaGFuID0geENvbXBhcmlzb24gLSAxO1xuICBsZXQgbGFzdExpbmUgPSB0aGlzLl9sYXN0TGluZTtcblxuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IHJhd0J5dGUgPSByYXdEYXRhWzEgKyB4XTtcbiAgICBsZXQgZjNVcCA9IGxhc3RMaW5lID8gbGFzdExpbmVbeF0gOiAwO1xuICAgIGxldCBmM0xlZnQgPSB4ID4geEJpZ2dlclRoYW4gPyB1bmZpbHRlcmVkTGluZVt4IC0geENvbXBhcmlzb25dIDogMDtcbiAgICBsZXQgZjNBZGQgPSBNYXRoLmZsb29yKChmM0xlZnQgKyBmM1VwKSAvIDIpO1xuICAgIHVuZmlsdGVyZWRMaW5lW3hdID0gcmF3Qnl0ZSArIGYzQWRkO1xuICB9XG59O1xuXG5GaWx0ZXIucHJvdG90eXBlLl91bkZpbHRlclR5cGU0ID0gZnVuY3Rpb24gKFxuICByYXdEYXRhLFxuICB1bmZpbHRlcmVkTGluZSxcbiAgYnl0ZVdpZHRoXG4pIHtcbiAgbGV0IHhDb21wYXJpc29uID0gdGhpcy5feENvbXBhcmlzb247XG4gIGxldCB4QmlnZ2VyVGhhbiA9IHhDb21wYXJpc29uIC0gMTtcbiAgbGV0IGxhc3RMaW5lID0gdGhpcy5fbGFzdExpbmU7XG5cbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCByYXdCeXRlID0gcmF3RGF0YVsxICsgeF07XG4gICAgbGV0IGY0VXAgPSBsYXN0TGluZSA/IGxhc3RMaW5lW3hdIDogMDtcbiAgICBsZXQgZjRMZWZ0ID0geCA+IHhCaWdnZXJUaGFuID8gdW5maWx0ZXJlZExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGY0VXBMZWZ0ID0geCA+IHhCaWdnZXJUaGFuICYmIGxhc3RMaW5lID8gbGFzdExpbmVbeCAtIHhDb21wYXJpc29uXSA6IDA7XG4gICAgbGV0IGY0QWRkID0gcGFldGhQcmVkaWN0b3IoZjRMZWZ0LCBmNFVwLCBmNFVwTGVmdCk7XG4gICAgdW5maWx0ZXJlZExpbmVbeF0gPSByYXdCeXRlICsgZjRBZGQ7XG4gIH1cbn07XG5cbkZpbHRlci5wcm90b3R5cGUuX3JldmVyc2VGaWx0ZXJMaW5lID0gZnVuY3Rpb24gKHJhd0RhdGEpIHtcbiAgbGV0IGZpbHRlciA9IHJhd0RhdGFbMF07XG4gIGxldCB1bmZpbHRlcmVkTGluZTtcbiAgbGV0IGN1cnJlbnRJbWFnZSA9IHRoaXMuX2ltYWdlc1t0aGlzLl9pbWFnZUluZGV4XTtcbiAgbGV0IGJ5dGVXaWR0aCA9IGN1cnJlbnRJbWFnZS5ieXRlV2lkdGg7XG5cbiAgaWYgKGZpbHRlciA9PT0gMCkge1xuICAgIHVuZmlsdGVyZWRMaW5lID0gcmF3RGF0YS5zbGljZSgxLCBieXRlV2lkdGggKyAxKTtcbiAgfSBlbHNlIHtcbiAgICB1bmZpbHRlcmVkTGluZSA9IEJ1ZmZlci5hbGxvYyhieXRlV2lkdGgpO1xuXG4gICAgc3dpdGNoIChmaWx0ZXIpIHtcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlMShyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIHRoaXMuX3VuRmlsdGVyVHlwZTIocmF3RGF0YSwgdW5maWx0ZXJlZExpbmUsIGJ5dGVXaWR0aCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAzOlxuICAgICAgICB0aGlzLl91bkZpbHRlclR5cGUzKHJhd0RhdGEsIHVuZmlsdGVyZWRMaW5lLCBieXRlV2lkdGgpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgNDpcbiAgICAgICAgdGhpcy5fdW5GaWx0ZXJUeXBlNChyYXdEYXRhLCB1bmZpbHRlcmVkTGluZSwgYnl0ZVdpZHRoKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJVbnJlY29nbmlzZWQgZmlsdGVyIHR5cGUgLSBcIiArIGZpbHRlcik7XG4gICAgfVxuICB9XG5cbiAgdGhpcy53cml0ZSh1bmZpbHRlcmVkTGluZSk7XG5cbiAgY3VycmVudEltYWdlLmxpbmVJbmRleCsrO1xuICBpZiAoY3VycmVudEltYWdlLmxpbmVJbmRleCA+PSBjdXJyZW50SW1hZ2UuaGVpZ2h0KSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSBudWxsO1xuICAgIHRoaXMuX2ltYWdlSW5kZXgrKztcbiAgICBjdXJyZW50SW1hZ2UgPSB0aGlzLl9pbWFnZXNbdGhpcy5faW1hZ2VJbmRleF07XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSB1bmZpbHRlcmVkTGluZTtcbiAgfVxuXG4gIGlmIChjdXJyZW50SW1hZ2UpIHtcbiAgICAvLyByZWFkLCB1c2luZyB0aGUgYnl0ZSB3aWR0aCB0aGF0IG1heSBiZSBmcm9tIHRoZSBuZXcgY3VycmVudCBpbWFnZVxuICAgIHRoaXMucmVhZChjdXJyZW50SW1hZ2UuYnl0ZVdpZHRoICsgMSwgdGhpcy5fcmV2ZXJzZUZpbHRlckxpbmUuYmluZCh0aGlzKSk7XG4gIH0gZWxzZSB7XG4gICAgdGhpcy5fbGFzdExpbmUgPSBudWxsO1xuICAgIHRoaXMuY29tcGxldGUoKTtcbiAgfVxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBDaHVua1N0cmVhbSA9IHJlcXVpcmUoXCIuL2NodW5rc3RyZWFtXCIpO1xubGV0IEZpbHRlciA9IHJlcXVpcmUoXCIuL2ZpbHRlci1wYXJzZVwiKTtcblxubGV0IEZpbHRlckFzeW5jID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGJpdG1hcEluZm8pIHtcbiAgQ2h1bmtTdHJlYW0uY2FsbCh0aGlzKTtcblxuICBsZXQgYnVmZmVycyA9IFtdO1xuICBsZXQgdGhhdCA9IHRoaXM7XG4gIHRoaXMuX2ZpbHRlciA9IG5ldyBGaWx0ZXIoYml0bWFwSW5mbywge1xuICAgIHJlYWQ6IHRoaXMucmVhZC5iaW5kKHRoaXMpLFxuICAgIHdyaXRlOiBmdW5jdGlvbiAoYnVmZmVyKSB7XG4gICAgICBidWZmZXJzLnB1c2goYnVmZmVyKTtcbiAgICB9LFxuICAgIGNvbXBsZXRlOiBmdW5jdGlvbiAoKSB7XG4gICAgICB0aGF0LmVtaXQoXCJjb21wbGV0ZVwiLCBCdWZmZXIuY29uY2F0KGJ1ZmZlcnMpKTtcbiAgICB9LFxuICB9KTtcblxuICB0aGlzLl9maWx0ZXIuc3RhcnQoKTtcbn0pO1xudXRpbC5pbmhlcml0cyhGaWx0ZXJBc3luYywgQ2h1bmtTdHJlYW0pO1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgUE5HX1NJR05BVFVSRTogWzB4ODksIDB4NTAsIDB4NGUsIDB4NDcsIDB4MGQsIDB4MGEsIDB4MWEsIDB4MGFdLFxuXG4gIFRZUEVfSUhEUjogMHg0OTQ4NDQ1MixcbiAgVFlQRV9JRU5EOiAweDQ5NDU0ZTQ0LFxuICBUWVBFX0lEQVQ6IDB4NDk0NDQxNTQsXG4gIFRZUEVfUExURTogMHg1MDRjNTQ0NSxcbiAgVFlQRV90Uk5TOiAweDc0NTI0ZTUzLCAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIGNhbWVsY2FzZVxuICBUWVBFX2dBTUE6IDB4Njc0MTRkNDEsIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgY2FtZWxjYXNlXG5cbiAgLy8gY29sb3ItdHlwZSBiaXRzXG4gIENPTE9SVFlQRV9HUkFZU0NBTEU6IDAsXG4gIENPTE9SVFlQRV9QQUxFVFRFOiAxLFxuICBDT0xPUlRZUEVfQ09MT1I6IDIsXG4gIENPTE9SVFlQRV9BTFBIQTogNCwgLy8gZS5nLiBncmF5c2NhbGUgYW5kIGFscGhhXG5cbiAgLy8gY29sb3ItdHlwZSBjb21iaW5hdGlvbnNcbiAgQ09MT1JUWVBFX1BBTEVUVEVfQ09MT1I6IDMsXG4gIENPTE9SVFlQRV9DT0xPUl9BTFBIQTogNixcblxuICBDT0xPUlRZUEVfVE9fQlBQX01BUDoge1xuICAgIDA6IDEsXG4gICAgMjogMyxcbiAgICAzOiAxLFxuICAgIDQ6IDIsXG4gICAgNjogNCxcbiAgfSxcblxuICBHQU1NQV9ESVZJU0lPTjogMTAwMDAwLFxufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGNyY1RhYmxlID0gW107XG5cbihmdW5jdGlvbiAoKSB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgMjU2OyBpKyspIHtcbiAgICBsZXQgY3VycmVudENyYyA9IGk7XG4gICAgZm9yIChsZXQgaiA9IDA7IGogPCA4OyBqKyspIHtcbiAgICAgIGlmIChjdXJyZW50Q3JjICYgMSkge1xuICAgICAgICBjdXJyZW50Q3JjID0gMHhlZGI4ODMyMCBeIChjdXJyZW50Q3JjID4+PiAxKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGN1cnJlbnRDcmMgPSBjdXJyZW50Q3JjID4+PiAxO1xuICAgICAgfVxuICAgIH1cbiAgICBjcmNUYWJsZVtpXSA9IGN1cnJlbnRDcmM7XG4gIH1cbn0pKCk7XG5cbmxldCBDcmNDYWxjdWxhdG9yID0gKG1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLl9jcmMgPSAtMTtcbn0pO1xuXG5DcmNDYWxjdWxhdG9yLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZGF0YS5sZW5ndGg7IGkrKykge1xuICAgIHRoaXMuX2NyYyA9IGNyY1RhYmxlWyh0aGlzLl9jcmMgXiBkYXRhW2ldKSAmIDB4ZmZdIF4gKHRoaXMuX2NyYyA+Pj4gOCk7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59O1xuXG5DcmNDYWxjdWxhdG9yLnByb3RvdHlwZS5jcmMzMiA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHRoaXMuX2NyYyBeIC0xO1xufTtcblxuQ3JjQ2FsY3VsYXRvci5jcmMzMiA9IGZ1bmN0aW9uIChidWYpIHtcbiAgbGV0IGNyYyA9IC0xO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IGJ1Zi5sZW5ndGg7IGkrKykge1xuICAgIGNyYyA9IGNyY1RhYmxlWyhjcmMgXiBidWZbaV0pICYgMHhmZl0gXiAoY3JjID4+PiA4KTtcbiAgfVxuICByZXR1cm4gY3JjIF4gLTE7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgY29uc3RhbnRzID0gcmVxdWlyZShcIi4vY29uc3RhbnRzXCIpO1xubGV0IENyY0NhbGN1bGF0b3IgPSByZXF1aXJlKFwiLi9jcmNcIik7XG5cbmxldCBQYXJzZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucywgZGVwZW5kZW5jaWVzKSB7XG4gIHRoaXMuX29wdGlvbnMgPSBvcHRpb25zO1xuICBvcHRpb25zLmNoZWNrQ1JDID0gb3B0aW9ucy5jaGVja0NSQyAhPT0gZmFsc2U7XG5cbiAgdGhpcy5faGFzSUhEUiA9IGZhbHNlO1xuICB0aGlzLl9oYXNJRU5EID0gZmFsc2U7XG4gIHRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQgPSBmYWxzZTtcblxuICAvLyBpbnB1dCBmbGFncy9tZXRhZGF0YVxuICB0aGlzLl9wYWxldHRlID0gW107XG4gIHRoaXMuX2NvbG9yVHlwZSA9IDA7XG5cbiAgdGhpcy5fY2h1bmtzID0ge307XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9JSERSXSA9IHRoaXMuX2hhbmRsZUlIRFIuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX0lFTkRdID0gdGhpcy5faGFuZGxlSUVORC5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfSURBVF0gPSB0aGlzLl9oYW5kbGVJREFULmJpbmQodGhpcyk7XG4gIHRoaXMuX2NodW5rc1tjb25zdGFudHMuVFlQRV9QTFRFXSA9IHRoaXMuX2hhbmRsZVBMVEUuYmluZCh0aGlzKTtcbiAgdGhpcy5fY2h1bmtzW2NvbnN0YW50cy5UWVBFX3RSTlNdID0gdGhpcy5faGFuZGxlVFJOUy5iaW5kKHRoaXMpO1xuICB0aGlzLl9jaHVua3NbY29uc3RhbnRzLlRZUEVfZ0FNQV0gPSB0aGlzLl9oYW5kbGVHQU1BLmJpbmQodGhpcyk7XG5cbiAgdGhpcy5yZWFkID0gZGVwZW5kZW5jaWVzLnJlYWQ7XG4gIHRoaXMuZXJyb3IgPSBkZXBlbmRlbmNpZXMuZXJyb3I7XG4gIHRoaXMubWV0YWRhdGEgPSBkZXBlbmRlbmNpZXMubWV0YWRhdGE7XG4gIHRoaXMuZ2FtbWEgPSBkZXBlbmRlbmNpZXMuZ2FtbWE7XG4gIHRoaXMudHJhbnNDb2xvciA9IGRlcGVuZGVuY2llcy50cmFuc0NvbG9yO1xuICB0aGlzLnBhbGV0dGUgPSBkZXBlbmRlbmNpZXMucGFsZXR0ZTtcbiAgdGhpcy5wYXJzZWQgPSBkZXBlbmRlbmNpZXMucGFyc2VkO1xuICB0aGlzLmluZmxhdGVEYXRhID0gZGVwZW5kZW5jaWVzLmluZmxhdGVEYXRhO1xuICB0aGlzLmZpbmlzaGVkID0gZGVwZW5kZW5jaWVzLmZpbmlzaGVkO1xuICB0aGlzLnNpbXBsZVRyYW5zcGFyZW5jeSA9IGRlcGVuZGVuY2llcy5zaW1wbGVUcmFuc3BhcmVuY3k7XG4gIHRoaXMuaGVhZGVyc0ZpbmlzaGVkID0gZGVwZW5kZW5jaWVzLmhlYWRlcnNGaW5pc2hlZCB8fCBmdW5jdGlvbiAoKSB7fTtcbn0pO1xuXG5QYXJzZXIucHJvdG90eXBlLnN0YXJ0ID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLnJlYWQoY29uc3RhbnRzLlBOR19TSUdOQVRVUkUubGVuZ3RoLCB0aGlzLl9wYXJzZVNpZ25hdHVyZS5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlU2lnbmF0dXJlID0gZnVuY3Rpb24gKGRhdGEpIHtcbiAgbGV0IHNpZ25hdHVyZSA9IGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgc2lnbmF0dXJlLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKGRhdGFbaV0gIT09IHNpZ25hdHVyZVtpXSkge1xuICAgICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJJbnZhbGlkIGZpbGUgc2lnbmF0dXJlXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gIH1cbiAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlQ2h1bmtCZWdpbiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIC8vIGNodW5rIGNvbnRlbnQgbGVuZ3RoXG4gIGxldCBsZW5ndGggPSBkYXRhLnJlYWRVSW50MzJCRSgwKTtcblxuICAvLyBjaHVuayB0eXBlXG4gIGxldCB0eXBlID0gZGF0YS5yZWFkVUludDMyQkUoNCk7XG4gIGxldCBuYW1lID0gXCJcIjtcbiAgZm9yIChsZXQgaSA9IDQ7IGkgPCA4OyBpKyspIHtcbiAgICBuYW1lICs9IFN0cmluZy5mcm9tQ2hhckNvZGUoZGF0YVtpXSk7XG4gIH1cblxuICAvL2NvbnNvbGUubG9nKCdjaHVuayAnLCBuYW1lLCBsZW5ndGgpO1xuXG4gIC8vIGNodW5rIGZsYWdzXG4gIGxldCBhbmNpbGxhcnkgPSBCb29sZWFuKGRhdGFbNF0gJiAweDIwKTsgLy8gb3IgY3JpdGljYWxcbiAgLy8gICAgcHJpdiA9IEJvb2xlYW4oZGF0YVs1XSAmIDB4MjApLCAvLyBvciBwdWJsaWNcbiAgLy8gICAgc2FmZVRvQ29weSA9IEJvb2xlYW4oZGF0YVs3XSAmIDB4MjApOyAvLyBvciB1bnNhZmVcblxuICBpZiAoIXRoaXMuX2hhc0lIRFIgJiYgdHlwZSAhPT0gY29uc3RhbnRzLlRZUEVfSUhEUikge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiRXhwZWN0ZWQgSUhEUiBvbiBiZWdnaW5pbmdcIikpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMuX2NyYyA9IG5ldyBDcmNDYWxjdWxhdG9yKCk7XG4gIHRoaXMuX2NyYy53cml0ZShCdWZmZXIuZnJvbShuYW1lKSk7XG5cbiAgaWYgKHRoaXMuX2NodW5rc1t0eXBlXSkge1xuICAgIHJldHVybiB0aGlzLl9jaHVua3NbdHlwZV0obGVuZ3RoKTtcbiAgfVxuXG4gIGlmICghYW5jaWxsYXJ5KSB7XG4gICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJVbnN1cHBvcnRlZCBjcml0aWNhbCBjaHVuayB0eXBlIFwiICsgbmFtZSkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIHRoaXMucmVhZChsZW5ndGggKyA0LCB0aGlzLl9za2lwQ2h1bmsuYmluZCh0aGlzKSk7XG59O1xuXG5QYXJzZXIucHJvdG90eXBlLl9za2lwQ2h1bmsgPSBmdW5jdGlvbiAoLypkYXRhKi8pIHtcbiAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUNodW5rRW5kID0gZnVuY3Rpb24gKCkge1xuICB0aGlzLnJlYWQoNCwgdGhpcy5fcGFyc2VDaHVua0VuZC5iaW5kKHRoaXMpKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX3BhcnNlQ2h1bmtFbmQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBsZXQgZmlsZUNyYyA9IGRhdGEucmVhZEludDMyQkUoMCk7XG4gIGxldCBjYWxjQ3JjID0gdGhpcy5fY3JjLmNyYzMyKCk7XG5cbiAgLy8gY2hlY2sgQ1JDXG4gIGlmICh0aGlzLl9vcHRpb25zLmNoZWNrQ1JDICYmIGNhbGNDcmMgIT09IGZpbGVDcmMpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIkNyYyBlcnJvciAtIFwiICsgZmlsZUNyYyArIFwiIC0gXCIgKyBjYWxjQ3JjKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKCF0aGlzLl9oYXNJRU5EKSB7XG4gICAgdGhpcy5yZWFkKDgsIHRoaXMuX3BhcnNlQ2h1bmtCZWdpbi5iaW5kKHRoaXMpKTtcbiAgfVxufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlSUhEUiA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VJSERSLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlSUhEUiA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICBsZXQgd2lkdGggPSBkYXRhLnJlYWRVSW50MzJCRSgwKTtcbiAgbGV0IGhlaWdodCA9IGRhdGEucmVhZFVJbnQzMkJFKDQpO1xuICBsZXQgZGVwdGggPSBkYXRhWzhdO1xuICBsZXQgY29sb3JUeXBlID0gZGF0YVs5XTsgLy8gYml0czogMSBwYWxldHRlLCAyIGNvbG9yLCA0IGFscGhhXG4gIGxldCBjb21wciA9IGRhdGFbMTBdO1xuICBsZXQgZmlsdGVyID0gZGF0YVsxMV07XG4gIGxldCBpbnRlcmxhY2UgPSBkYXRhWzEyXTtcblxuICAvLyBjb25zb2xlLmxvZygnICAgIHdpZHRoJywgd2lkdGgsICdoZWlnaHQnLCBoZWlnaHQsXG4gIC8vICAgICAnZGVwdGgnLCBkZXB0aCwgJ2NvbG9yVHlwZScsIGNvbG9yVHlwZSxcbiAgLy8gICAgICdjb21wcicsIGNvbXByLCAnZmlsdGVyJywgZmlsdGVyLCAnaW50ZXJsYWNlJywgaW50ZXJsYWNlXG4gIC8vICk7XG5cbiAgaWYgKFxuICAgIGRlcHRoICE9PSA4ICYmXG4gICAgZGVwdGggIT09IDQgJiZcbiAgICBkZXB0aCAhPT0gMiAmJlxuICAgIGRlcHRoICE9PSAxICYmXG4gICAgZGVwdGggIT09IDE2XG4gICkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgYml0IGRlcHRoIFwiICsgZGVwdGgpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCEoY29sb3JUeXBlIGluIGNvbnN0YW50cy5DT0xPUlRZUEVfVE9fQlBQX01BUCkpIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGNvbG9yIHR5cGVcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoY29tcHIgIT09IDApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGNvbXByZXNzaW9uIG1ldGhvZFwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChmaWx0ZXIgIT09IDApIHtcbiAgICB0aGlzLmVycm9yKG5ldyBFcnJvcihcIlVuc3VwcG9ydGVkIGZpbHRlciBtZXRob2RcIikpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAoaW50ZXJsYWNlICE9PSAwICYmIGludGVybGFjZSAhPT0gMSkge1xuICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiVW5zdXBwb3J0ZWQgaW50ZXJsYWNlIG1ldGhvZFwiKSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy5fY29sb3JUeXBlID0gY29sb3JUeXBlO1xuXG4gIGxldCBicHAgPSBjb25zdGFudHMuQ09MT1JUWVBFX1RPX0JQUF9NQVBbdGhpcy5fY29sb3JUeXBlXTtcblxuICB0aGlzLl9oYXNJSERSID0gdHJ1ZTtcblxuICB0aGlzLm1ldGFkYXRhKHtcbiAgICB3aWR0aDogd2lkdGgsXG4gICAgaGVpZ2h0OiBoZWlnaHQsXG4gICAgZGVwdGg6IGRlcHRoLFxuICAgIGludGVybGFjZTogQm9vbGVhbihpbnRlcmxhY2UpLFxuICAgIHBhbGV0dGU6IEJvb2xlYW4oY29sb3JUeXBlICYgY29uc3RhbnRzLkNPTE9SVFlQRV9QQUxFVFRFKSxcbiAgICBjb2xvcjogQm9vbGVhbihjb2xvclR5cGUgJiBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SKSxcbiAgICBhbHBoYTogQm9vbGVhbihjb2xvclR5cGUgJiBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBKSxcbiAgICBicHA6IGJwcCxcbiAgICBjb2xvclR5cGU6IGNvbG9yVHlwZSxcbiAgfSk7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZVBMVEUgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlUExURS5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZVBMVEUgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgbGV0IGVudHJpZXMgPSBNYXRoLmZsb29yKGRhdGEubGVuZ3RoIC8gMyk7XG4gIC8vIGNvbnNvbGUubG9nKCdQYWxldHRlOicsIGVudHJpZXMpO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwgZW50cmllczsgaSsrKSB7XG4gICAgdGhpcy5fcGFsZXR0ZS5wdXNoKFtkYXRhW2kgKiAzXSwgZGF0YVtpICogMyArIDFdLCBkYXRhW2kgKiAzICsgMl0sIDB4ZmZdKTtcbiAgfVxuXG4gIHRoaXMucGFsZXR0ZSh0aGlzLl9wYWxldHRlKTtcblxuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlVFJOUyA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5zaW1wbGVUcmFuc3BhcmVuY3koKTtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VUUk5TLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlVFJOUyA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcblxuICAvLyBwYWxldHRlXG4gIGlmICh0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURV9DT0xPUikge1xuICAgIGlmICh0aGlzLl9wYWxldHRlLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhpcy5lcnJvcihuZXcgRXJyb3IoXCJUcmFuc3BhcmVuY3kgY2h1bmsgbXVzdCBiZSBhZnRlciBwYWxldHRlXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKGRhdGEubGVuZ3RoID4gdGhpcy5fcGFsZXR0ZS5sZW5ndGgpIHtcbiAgICAgIHRoaXMuZXJyb3IobmV3IEVycm9yKFwiTW9yZSB0cmFuc3BhcmVudCBjb2xvcnMgdGhhbiBwYWxldHRlIHNpemVcIikpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGRhdGEubGVuZ3RoOyBpKyspIHtcbiAgICAgIHRoaXMuX3BhbGV0dGVbaV1bM10gPSBkYXRhW2ldO1xuICAgIH1cbiAgICB0aGlzLnBhbGV0dGUodGhpcy5fcGFsZXR0ZSk7XG4gIH1cblxuICAvLyBmb3IgY29sb3JUeXBlIDAgKGdyYXlzY2FsZSkgYW5kIDIgKHJnYilcbiAgLy8gdGhlcmUgbWlnaHQgYmUgb25lIGdyYXkvY29sb3IgZGVmaW5lZCBhcyB0cmFuc3BhcmVudFxuICBpZiAodGhpcy5fY29sb3JUeXBlID09PSBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSkge1xuICAgIC8vIGdyZXksIDIgYnl0ZXNcbiAgICB0aGlzLnRyYW5zQ29sb3IoW2RhdGEucmVhZFVJbnQxNkJFKDApXSk7XG4gIH1cbiAgaWYgKHRoaXMuX2NvbG9yVHlwZSA9PT0gY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUikge1xuICAgIHRoaXMudHJhbnNDb2xvcihbXG4gICAgICBkYXRhLnJlYWRVSW50MTZCRSgwKSxcbiAgICAgIGRhdGEucmVhZFVJbnQxNkJFKDIpLFxuICAgICAgZGF0YS5yZWFkVUludDE2QkUoNCksXG4gICAgXSk7XG4gIH1cblxuICB0aGlzLl9oYW5kbGVDaHVua0VuZCgpO1xufTtcblxuUGFyc2VyLnByb3RvdHlwZS5faGFuZGxlR0FNQSA9IGZ1bmN0aW9uIChsZW5ndGgpIHtcbiAgdGhpcy5yZWFkKGxlbmd0aCwgdGhpcy5fcGFyc2VHQU1BLmJpbmQodGhpcykpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlR0FNQSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX2NyYy53cml0ZShkYXRhKTtcbiAgdGhpcy5nYW1tYShkYXRhLnJlYWRVSW50MzJCRSgwKSAvIGNvbnN0YW50cy5HQU1NQV9ESVZJU0lPTik7XG5cbiAgdGhpcy5faGFuZGxlQ2h1bmtFbmQoKTtcbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlEQVQgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIGlmICghdGhpcy5fZW1pdHRlZEhlYWRlcnNGaW5pc2hlZCkge1xuICAgIHRoaXMuX2VtaXR0ZWRIZWFkZXJzRmluaXNoZWQgPSB0cnVlO1xuICAgIHRoaXMuaGVhZGVyc0ZpbmlzaGVkKCk7XG4gIH1cbiAgdGhpcy5yZWFkKC1sZW5ndGgsIHRoaXMuX3BhcnNlSURBVC5iaW5kKHRoaXMsIGxlbmd0aCkpO1xufTtcblBhcnNlci5wcm90b3R5cGUuX3BhcnNlSURBVCA9IGZ1bmN0aW9uIChsZW5ndGgsIGRhdGEpIHtcbiAgdGhpcy5fY3JjLndyaXRlKGRhdGEpO1xuXG4gIGlmIChcbiAgICB0aGlzLl9jb2xvclR5cGUgPT09IGNvbnN0YW50cy5DT0xPUlRZUEVfUEFMRVRURV9DT0xPUiAmJlxuICAgIHRoaXMuX3BhbGV0dGUubGVuZ3RoID09PSAwXG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIkV4cGVjdGVkIHBhbGV0dGUgbm90IGZvdW5kXCIpO1xuICB9XG5cbiAgdGhpcy5pbmZsYXRlRGF0YShkYXRhKTtcbiAgbGV0IGxlZnRPdmVyTGVuZ3RoID0gbGVuZ3RoIC0gZGF0YS5sZW5ndGg7XG5cbiAgaWYgKGxlZnRPdmVyTGVuZ3RoID4gMCkge1xuICAgIHRoaXMuX2hhbmRsZUlEQVQobGVmdE92ZXJMZW5ndGgpO1xuICB9IGVsc2Uge1xuICAgIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG4gIH1cbn07XG5cblBhcnNlci5wcm90b3R5cGUuX2hhbmRsZUlFTkQgPSBmdW5jdGlvbiAobGVuZ3RoKSB7XG4gIHRoaXMucmVhZChsZW5ndGgsIHRoaXMuX3BhcnNlSUVORC5iaW5kKHRoaXMpKTtcbn07XG5QYXJzZXIucHJvdG90eXBlLl9wYXJzZUlFTkQgPSBmdW5jdGlvbiAoZGF0YSkge1xuICB0aGlzLl9jcmMud3JpdGUoZGF0YSk7XG5cbiAgdGhpcy5faGFzSUVORCA9IHRydWU7XG4gIHRoaXMuX2hhbmRsZUNodW5rRW5kKCk7XG5cbiAgaWYgKHRoaXMuZmluaXNoZWQpIHtcbiAgICB0aGlzLmZpbmlzaGVkKCk7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBpbnRlcmxhY2VVdGlscyA9IHJlcXVpcmUoXCIuL2ludGVybGFjZVwiKTtcblxubGV0IHBpeGVsQnBwTWFwcGVyID0gW1xuICAvLyAwIC0gZHVtbXkgZW50cnlcbiAgZnVuY3Rpb24gKCkge30sXG5cbiAgLy8gMSAtIExcbiAgLy8gMDogMCwgMTogMCwgMjogMCwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBkYXRhLCBweFBvcywgcmF3UG9zKSB7XG4gICAgaWYgKHJhd1BvcyA9PT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG5cbiAgICBsZXQgcGl4ZWwgPSBkYXRhW3Jhd1Bvc107XG4gICAgcHhEYXRhW3B4UG9zXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAzXSA9IDB4ZmY7XG4gIH0sXG5cbiAgLy8gMiAtIExBXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDFcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAxID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgbGV0IHBpeGVsID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBkYXRhW3Jhd1BvcyArIDFdO1xuICB9LFxuXG4gIC8vIDMgLSBSR0JcbiAgLy8gMDogMCwgMTogMSwgMjogMiwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBkYXRhLCBweFBvcywgcmF3UG9zKSB7XG4gICAgaWYgKHJhd1BvcyArIDIgPj0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG5cbiAgICBweERhdGFbcHhQb3NdID0gZGF0YVtyYXdQb3NdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gZGF0YVtyYXdQb3MgKyAxXTtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IGRhdGFbcmF3UG9zICsgMl07XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSAweGZmO1xuICB9LFxuXG4gIC8vIDQgLSBSR0JBXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDNcbiAgZnVuY3Rpb24gKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcykge1xuICAgIGlmIChyYXdQb3MgKyAzID49IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJSYW4gb3V0IG9mIGRhdGFcIik7XG4gICAgfVxuXG4gICAgcHhEYXRhW3B4UG9zXSA9IGRhdGFbcmF3UG9zXTtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IGRhdGFbcmF3UG9zICsgMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBkYXRhW3Jhd1BvcyArIDJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gZGF0YVtyYXdQb3MgKyAzXTtcbiAgfSxcbl07XG5cbmxldCBwaXhlbEJwcEN1c3RvbU1hcHBlciA9IFtcbiAgLy8gMCAtIGR1bW15IGVudHJ5XG4gIGZ1bmN0aW9uICgpIHt9LFxuXG4gIC8vIDEgLSBMXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDB4ZmZcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcywgbWF4Qml0KSB7XG4gICAgbGV0IHBpeGVsID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAxXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBtYXhCaXQ7XG4gIH0sXG5cbiAgLy8gMiAtIExBXG4gIC8vIDA6IDAsIDE6IDAsIDI6IDAsIDM6IDFcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcykge1xuICAgIGxldCBwaXhlbCA9IHBpeGVsRGF0YVswXTtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWw7XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbDtcbiAgICBweERhdGFbcHhQb3MgKyAyXSA9IHBpeGVsO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gcGl4ZWxEYXRhWzFdO1xuICB9LFxuXG4gIC8vIDMgLSBSR0JcbiAgLy8gMDogMCwgMTogMSwgMjogMiwgMzogMHhmZlxuICBmdW5jdGlvbiAocHhEYXRhLCBwaXhlbERhdGEsIHB4UG9zLCBtYXhCaXQpIHtcbiAgICBweERhdGFbcHhQb3NdID0gcGl4ZWxEYXRhWzBdO1xuICAgIHB4RGF0YVtweFBvcyArIDFdID0gcGl4ZWxEYXRhWzFdO1xuICAgIHB4RGF0YVtweFBvcyArIDJdID0gcGl4ZWxEYXRhWzJdO1xuICAgIHB4RGF0YVtweFBvcyArIDNdID0gbWF4Qml0O1xuICB9LFxuXG4gIC8vIDQgLSBSR0JBXG4gIC8vIDA6IDAsIDE6IDEsIDI6IDIsIDM6IDNcbiAgZnVuY3Rpb24gKHB4RGF0YSwgcGl4ZWxEYXRhLCBweFBvcykge1xuICAgIHB4RGF0YVtweFBvc10gPSBwaXhlbERhdGFbMF07XG4gICAgcHhEYXRhW3B4UG9zICsgMV0gPSBwaXhlbERhdGFbMV07XG4gICAgcHhEYXRhW3B4UG9zICsgMl0gPSBwaXhlbERhdGFbMl07XG4gICAgcHhEYXRhW3B4UG9zICsgM10gPSBwaXhlbERhdGFbM107XG4gIH0sXG5dO1xuXG5mdW5jdGlvbiBiaXRSZXRyaWV2ZXIoZGF0YSwgZGVwdGgpIHtcbiAgbGV0IGxlZnRPdmVyID0gW107XG4gIGxldCBpID0gMDtcblxuICBmdW5jdGlvbiBzcGxpdCgpIHtcbiAgICBpZiAoaSA9PT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIlJhbiBvdXQgb2YgZGF0YVwiKTtcbiAgICB9XG4gICAgbGV0IGJ5dGUgPSBkYXRhW2ldO1xuICAgIGkrKztcbiAgICBsZXQgYnl0ZTgsIGJ5dGU3LCBieXRlNiwgYnl0ZTUsIGJ5dGU0LCBieXRlMywgYnl0ZTIsIGJ5dGUxO1xuICAgIHN3aXRjaCAoZGVwdGgpIHtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBkZXB0aFwiKTtcbiAgICAgIGNhc2UgMTY6XG4gICAgICAgIGJ5dGUyID0gZGF0YVtpXTtcbiAgICAgICAgaSsrO1xuICAgICAgICBsZWZ0T3Zlci5wdXNoKChieXRlIDw8IDgpICsgYnl0ZTIpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgNDpcbiAgICAgICAgYnl0ZTIgPSBieXRlICYgMHgwZjtcbiAgICAgICAgYnl0ZTEgPSBieXRlID4+IDQ7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIDI6XG4gICAgICAgIGJ5dGU0ID0gYnl0ZSAmIDM7XG4gICAgICAgIGJ5dGUzID0gKGJ5dGUgPj4gMikgJiAzO1xuICAgICAgICBieXRlMiA9IChieXRlID4+IDQpICYgMztcbiAgICAgICAgYnl0ZTEgPSAoYnl0ZSA+PiA2KSAmIDM7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyLCBieXRlMywgYnl0ZTQpO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgMTpcbiAgICAgICAgYnl0ZTggPSBieXRlICYgMTtcbiAgICAgICAgYnl0ZTcgPSAoYnl0ZSA+PiAxKSAmIDE7XG4gICAgICAgIGJ5dGU2ID0gKGJ5dGUgPj4gMikgJiAxO1xuICAgICAgICBieXRlNSA9IChieXRlID4+IDMpICYgMTtcbiAgICAgICAgYnl0ZTQgPSAoYnl0ZSA+PiA0KSAmIDE7XG4gICAgICAgIGJ5dGUzID0gKGJ5dGUgPj4gNSkgJiAxO1xuICAgICAgICBieXRlMiA9IChieXRlID4+IDYpICYgMTtcbiAgICAgICAgYnl0ZTEgPSAoYnl0ZSA+PiA3KSAmIDE7XG4gICAgICAgIGxlZnRPdmVyLnB1c2goYnl0ZTEsIGJ5dGUyLCBieXRlMywgYnl0ZTQsIGJ5dGU1LCBieXRlNiwgYnl0ZTcsIGJ5dGU4KTtcbiAgICAgICAgYnJlYWs7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBnZXQ6IGZ1bmN0aW9uIChjb3VudCkge1xuICAgICAgd2hpbGUgKGxlZnRPdmVyLmxlbmd0aCA8IGNvdW50KSB7XG4gICAgICAgIHNwbGl0KCk7XG4gICAgICB9XG4gICAgICBsZXQgcmV0dXJuZXIgPSBsZWZ0T3Zlci5zbGljZSgwLCBjb3VudCk7XG4gICAgICBsZWZ0T3ZlciA9IGxlZnRPdmVyLnNsaWNlKGNvdW50KTtcbiAgICAgIHJldHVybiByZXR1cm5lcjtcbiAgICB9LFxuICAgIHJlc2V0QWZ0ZXJMaW5lOiBmdW5jdGlvbiAoKSB7XG4gICAgICBsZWZ0T3Zlci5sZW5ndGggPSAwO1xuICAgIH0sXG4gICAgZW5kOiBmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoaSAhPT0gZGF0YS5sZW5ndGgpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiZXh0cmEgZGF0YSBmb3VuZFwiKTtcbiAgICAgIH1cbiAgICB9LFxuICB9O1xufVxuXG5mdW5jdGlvbiBtYXBJbWFnZThCaXQoaW1hZ2UsIHB4RGF0YSwgZ2V0UHhQb3MsIGJwcCwgZGF0YSwgcmF3UG9zKSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICBsZXQgaW1hZ2VXaWR0aCA9IGltYWdlLndpZHRoO1xuICBsZXQgaW1hZ2VIZWlnaHQgPSBpbWFnZS5oZWlnaHQ7XG4gIGxldCBpbWFnZVBhc3MgPSBpbWFnZS5pbmRleDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBpbWFnZUhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCBpbWFnZVdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBweFBvcyA9IGdldFB4UG9zKHgsIHksIGltYWdlUGFzcyk7XG4gICAgICBwaXhlbEJwcE1hcHBlclticHBdKHB4RGF0YSwgZGF0YSwgcHhQb3MsIHJhd1Bvcyk7XG4gICAgICByYXdQb3MgKz0gYnBwOyAvL2VzbGludC1kaXNhYmxlLWxpbmUgbm8tcGFyYW0tcmVhc3NpZ25cbiAgICB9XG4gIH1cbiAgcmV0dXJuIHJhd1Bvcztcbn1cblxuZnVuY3Rpb24gbWFwSW1hZ2VDdXN0b21CaXQoaW1hZ2UsIHB4RGF0YSwgZ2V0UHhQb3MsIGJwcCwgYml0cywgbWF4Qml0KSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICBsZXQgaW1hZ2VXaWR0aCA9IGltYWdlLndpZHRoO1xuICBsZXQgaW1hZ2VIZWlnaHQgPSBpbWFnZS5oZWlnaHQ7XG4gIGxldCBpbWFnZVBhc3MgPSBpbWFnZS5pbmRleDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBpbWFnZUhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCBpbWFnZVdpZHRoOyB4KyspIHtcbiAgICAgIGxldCBwaXhlbERhdGEgPSBiaXRzLmdldChicHApO1xuICAgICAgbGV0IHB4UG9zID0gZ2V0UHhQb3MoeCwgeSwgaW1hZ2VQYXNzKTtcbiAgICAgIHBpeGVsQnBwQ3VzdG9tTWFwcGVyW2JwcF0ocHhEYXRhLCBwaXhlbERhdGEsIHB4UG9zLCBtYXhCaXQpO1xuICAgIH1cbiAgICBiaXRzLnJlc2V0QWZ0ZXJMaW5lKCk7XG4gIH1cbn1cblxuZXhwb3J0cy5kYXRhVG9CaXRNYXAgPSBmdW5jdGlvbiAoZGF0YSwgYml0bWFwSW5mbykge1xuICBsZXQgd2lkdGggPSBiaXRtYXBJbmZvLndpZHRoO1xuICBsZXQgaGVpZ2h0ID0gYml0bWFwSW5mby5oZWlnaHQ7XG4gIGxldCBkZXB0aCA9IGJpdG1hcEluZm8uZGVwdGg7XG4gIGxldCBicHAgPSBiaXRtYXBJbmZvLmJwcDtcbiAgbGV0IGludGVybGFjZSA9IGJpdG1hcEluZm8uaW50ZXJsYWNlO1xuICBsZXQgYml0cztcblxuICBpZiAoZGVwdGggIT09IDgpIHtcbiAgICBiaXRzID0gYml0UmV0cmlldmVyKGRhdGEsIGRlcHRoKTtcbiAgfVxuICBsZXQgcHhEYXRhO1xuICBpZiAoZGVwdGggPD0gOCkge1xuICAgIHB4RGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICB9IGVsc2Uge1xuICAgIHB4RGF0YSA9IG5ldyBVaW50MTZBcnJheSh3aWR0aCAqIGhlaWdodCAqIDQpO1xuICB9XG4gIGxldCBtYXhCaXQgPSBNYXRoLnBvdygyLCBkZXB0aCkgLSAxO1xuICBsZXQgcmF3UG9zID0gMDtcbiAgbGV0IGltYWdlcztcbiAgbGV0IGdldFB4UG9zO1xuXG4gIGlmIChpbnRlcmxhY2UpIHtcbiAgICBpbWFnZXMgPSBpbnRlcmxhY2VVdGlscy5nZXRJbWFnZVBhc3Nlcyh3aWR0aCwgaGVpZ2h0KTtcbiAgICBnZXRQeFBvcyA9IGludGVybGFjZVV0aWxzLmdldEludGVybGFjZUl0ZXJhdG9yKHdpZHRoLCBoZWlnaHQpO1xuICB9IGVsc2Uge1xuICAgIGxldCBub25JbnRlcmxhY2VkUHhQb3MgPSAwO1xuICAgIGdldFB4UG9zID0gZnVuY3Rpb24gKCkge1xuICAgICAgbGV0IHJldHVybmVyID0gbm9uSW50ZXJsYWNlZFB4UG9zO1xuICAgICAgbm9uSW50ZXJsYWNlZFB4UG9zICs9IDQ7XG4gICAgICByZXR1cm4gcmV0dXJuZXI7XG4gICAgfTtcbiAgICBpbWFnZXMgPSBbeyB3aWR0aDogd2lkdGgsIGhlaWdodDogaGVpZ2h0IH1dO1xuICB9XG5cbiAgZm9yIChsZXQgaW1hZ2VJbmRleCA9IDA7IGltYWdlSW5kZXggPCBpbWFnZXMubGVuZ3RoOyBpbWFnZUluZGV4KyspIHtcbiAgICBpZiAoZGVwdGggPT09IDgpIHtcbiAgICAgIHJhd1BvcyA9IG1hcEltYWdlOEJpdChcbiAgICAgICAgaW1hZ2VzW2ltYWdlSW5kZXhdLFxuICAgICAgICBweERhdGEsXG4gICAgICAgIGdldFB4UG9zLFxuICAgICAgICBicHAsXG4gICAgICAgIGRhdGEsXG4gICAgICAgIHJhd1Bvc1xuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbWFwSW1hZ2VDdXN0b21CaXQoXG4gICAgICAgIGltYWdlc1tpbWFnZUluZGV4XSxcbiAgICAgICAgcHhEYXRhLFxuICAgICAgICBnZXRQeFBvcyxcbiAgICAgICAgYnBwLFxuICAgICAgICBiaXRzLFxuICAgICAgICBtYXhCaXRcbiAgICAgICk7XG4gICAgfVxuICB9XG4gIGlmIChkZXB0aCA9PT0gOCkge1xuICAgIGlmIChyYXdQb3MgIT09IGRhdGEubGVuZ3RoKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJleHRyYSBkYXRhIGZvdW5kXCIpO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBiaXRzLmVuZCgpO1xuICB9XG5cbiAgcmV0dXJuIHB4RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmZ1bmN0aW9uIGRlUGFsZXR0ZShpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIHBhbGV0dGUpIHtcbiAgbGV0IHB4UG9zID0gMDtcbiAgLy8gdXNlIHZhbHVlcyBmcm9tIHBhbGV0dGVcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IGNvbG9yID0gcGFsZXR0ZVtpbmRhdGFbcHhQb3NdXTtcblxuICAgICAgaWYgKCFjb2xvcikge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJpbmRleCBcIiArIGluZGF0YVtweFBvc10gKyBcIiBub3QgaW4gcGFsZXR0ZVwiKTtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgb3V0ZGF0YVtweFBvcyArIGldID0gY29sb3JbaV07XG4gICAgICB9XG4gICAgICBweFBvcyArPSA0O1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiByZXBsYWNlVHJhbnNwYXJlbnRDb2xvcihpbmRhdGEsIG91dGRhdGEsIHdpZHRoLCBoZWlnaHQsIHRyYW5zQ29sb3IpIHtcbiAgbGV0IHB4UG9zID0gMDtcbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IG1ha2VUcmFucyA9IGZhbHNlO1xuXG4gICAgICBpZiAodHJhbnNDb2xvci5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgaWYgKHRyYW5zQ29sb3JbMF0gPT09IGluZGF0YVtweFBvc10pIHtcbiAgICAgICAgICBtYWtlVHJhbnMgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICB0cmFuc0NvbG9yWzBdID09PSBpbmRhdGFbcHhQb3NdICYmXG4gICAgICAgIHRyYW5zQ29sb3JbMV0gPT09IGluZGF0YVtweFBvcyArIDFdICYmXG4gICAgICAgIHRyYW5zQ29sb3JbMl0gPT09IGluZGF0YVtweFBvcyArIDJdXG4gICAgICApIHtcbiAgICAgICAgbWFrZVRyYW5zID0gdHJ1ZTtcbiAgICAgIH1cbiAgICAgIGlmIChtYWtlVHJhbnMpIHtcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCA0OyBpKyspIHtcbiAgICAgICAgICBvdXRkYXRhW3B4UG9zICsgaV0gPSAwO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBweFBvcyArPSA0O1xuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBzY2FsZURlcHRoKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgZGVwdGgpIHtcbiAgbGV0IG1heE91dFNhbXBsZSA9IDI1NTtcbiAgbGV0IG1heEluU2FtcGxlID0gTWF0aC5wb3coMiwgZGVwdGgpIC0gMTtcbiAgbGV0IHB4UG9zID0gMDtcblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgZm9yIChsZXQgeCA9IDA7IHggPCB3aWR0aDsgeCsrKSB7XG4gICAgICBmb3IgKGxldCBpID0gMDsgaSA8IDQ7IGkrKykge1xuICAgICAgICBvdXRkYXRhW3B4UG9zICsgaV0gPSBNYXRoLmZsb29yKFxuICAgICAgICAgIChpbmRhdGFbcHhQb3MgKyBpXSAqIG1heE91dFNhbXBsZSkgLyBtYXhJblNhbXBsZSArIDAuNVxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcHhQb3MgKz0gNDtcbiAgICB9XG4gIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAoaW5kYXRhLCBpbWFnZURhdGEsIHNraXBSZXNjYWxlID0gZmFsc2UpIHtcbiAgbGV0IGRlcHRoID0gaW1hZ2VEYXRhLmRlcHRoO1xuICBsZXQgd2lkdGggPSBpbWFnZURhdGEud2lkdGg7XG4gIGxldCBoZWlnaHQgPSBpbWFnZURhdGEuaGVpZ2h0O1xuICBsZXQgY29sb3JUeXBlID0gaW1hZ2VEYXRhLmNvbG9yVHlwZTtcbiAgbGV0IHRyYW5zQ29sb3IgPSBpbWFnZURhdGEudHJhbnNDb2xvcjtcbiAgbGV0IHBhbGV0dGUgPSBpbWFnZURhdGEucGFsZXR0ZTtcblxuICBsZXQgb3V0ZGF0YSA9IGluZGF0YTsgLy8gb25seSBkaWZmZXJlbnQgZm9yIDE2IGJpdHNcblxuICBpZiAoY29sb3JUeXBlID09PSAzKSB7XG4gICAgLy8gcGFsZXR0ZWRcbiAgICBkZVBhbGV0dGUoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCBwYWxldHRlKTtcbiAgfSBlbHNlIHtcbiAgICBpZiAodHJhbnNDb2xvcikge1xuICAgICAgcmVwbGFjZVRyYW5zcGFyZW50Q29sb3IoaW5kYXRhLCBvdXRkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0cmFuc0NvbG9yKTtcbiAgICB9XG4gICAgLy8gaWYgaXQgbmVlZHMgc2NhbGluZ1xuICAgIGlmIChkZXB0aCAhPT0gOCAmJiAhc2tpcFJlc2NhbGUpIHtcbiAgICAgIC8vIGlmIHdlIG5lZWQgdG8gY2hhbmdlIHRoZSBidWZmZXIgc2l6ZVxuICAgICAgaWYgKGRlcHRoID09PSAxNikge1xuICAgICAgICBvdXRkYXRhID0gQnVmZmVyLmFsbG9jKHdpZHRoICogaGVpZ2h0ICogNCk7XG4gICAgICB9XG4gICAgICBzY2FsZURlcHRoKGluZGF0YSwgb3V0ZGF0YSwgd2lkdGgsIGhlaWdodCwgZGVwdGgpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0ZGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5sZXQgemxpYiA9IHJlcXVpcmUoXCJ6bGliXCIpO1xubGV0IENodW5rU3RyZWFtID0gcmVxdWlyZShcIi4vY2h1bmtzdHJlYW1cIik7XG5sZXQgRmlsdGVyQXN5bmMgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFyc2UtYXN5bmNcIik7XG5sZXQgUGFyc2VyID0gcmVxdWlyZShcIi4vcGFyc2VyXCIpO1xubGV0IGJpdG1hcHBlciA9IHJlcXVpcmUoXCIuL2JpdG1hcHBlclwiKTtcbmxldCBmb3JtYXROb3JtYWxpc2VyID0gcmVxdWlyZShcIi4vZm9ybWF0LW5vcm1hbGlzZXJcIik7XG5cbmxldCBQYXJzZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChvcHRpb25zKSB7XG4gIENodW5rU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgdGhpcy5fcGFyc2VyID0gbmV3IFBhcnNlcihvcHRpb25zLCB7XG4gICAgcmVhZDogdGhpcy5yZWFkLmJpbmQodGhpcyksXG4gICAgZXJyb3I6IHRoaXMuX2hhbmRsZUVycm9yLmJpbmQodGhpcyksXG4gICAgbWV0YWRhdGE6IHRoaXMuX2hhbmRsZU1ldGFEYXRhLmJpbmQodGhpcyksXG4gICAgZ2FtbWE6IHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZ2FtbWFcIiksXG4gICAgcGFsZXR0ZTogdGhpcy5faGFuZGxlUGFsZXR0ZS5iaW5kKHRoaXMpLFxuICAgIHRyYW5zQ29sb3I6IHRoaXMuX2hhbmRsZVRyYW5zQ29sb3IuYmluZCh0aGlzKSxcbiAgICBmaW5pc2hlZDogdGhpcy5fZmluaXNoZWQuYmluZCh0aGlzKSxcbiAgICBpbmZsYXRlRGF0YTogdGhpcy5faW5mbGF0ZURhdGEuYmluZCh0aGlzKSxcbiAgICBzaW1wbGVUcmFuc3BhcmVuY3k6IHRoaXMuX3NpbXBsZVRyYW5zcGFyZW5jeS5iaW5kKHRoaXMpLFxuICAgIGhlYWRlcnNGaW5pc2hlZDogdGhpcy5faGVhZGVyc0ZpbmlzaGVkLmJpbmQodGhpcyksXG4gIH0pO1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcbiAgdGhpcy53cml0YWJsZSA9IHRydWU7XG5cbiAgdGhpcy5fcGFyc2VyLnN0YXJ0KCk7XG59KTtcbnV0aWwuaW5oZXJpdHMoUGFyc2VyQXN5bmMsIENodW5rU3RyZWFtKTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVFcnJvciA9IGZ1bmN0aW9uIChlcnIpIHtcbiAgdGhpcy5lbWl0KFwiZXJyb3JcIiwgZXJyKTtcblxuICB0aGlzLndyaXRhYmxlID0gZmFsc2U7XG5cbiAgdGhpcy5kZXN0cm95KCk7XG5cbiAgaWYgKHRoaXMuX2luZmxhdGUgJiYgdGhpcy5faW5mbGF0ZS5kZXN0cm95KSB7XG4gICAgdGhpcy5faW5mbGF0ZS5kZXN0cm95KCk7XG4gIH1cblxuICBpZiAodGhpcy5fZmlsdGVyKSB7XG4gICAgdGhpcy5fZmlsdGVyLmRlc3Ryb3koKTtcbiAgICAvLyBGb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eSB3aXRoIE5vZGUgNyBhbmQgYmVsb3cuXG4gICAgLy8gU3VwcHJlc3MgZXJyb3JzIGR1ZSB0byBfaW5mbGF0ZSBjYWxsaW5nIHdyaXRlKCkgZXZlbiBhZnRlclxuICAgIC8vIGl0J3MgZGVzdHJveSgpJ2VkLlxuICAgIHRoaXMuX2ZpbHRlci5vbihcImVycm9yXCIsIGZ1bmN0aW9uICgpIHt9KTtcbiAgfVxuXG4gIHRoaXMuZXJyb3JkID0gdHJ1ZTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faW5mbGF0ZURhdGEgPSBmdW5jdGlvbiAoZGF0YSkge1xuICBpZiAoIXRoaXMuX2luZmxhdGUpIHtcbiAgICBpZiAodGhpcy5fYml0bWFwSW5mby5pbnRlcmxhY2UpIHtcbiAgICAgIHRoaXMuX2luZmxhdGUgPSB6bGliLmNyZWF0ZUluZmxhdGUoKTtcblxuICAgICAgdGhpcy5faW5mbGF0ZS5vbihcImVycm9yXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIikpO1xuICAgICAgdGhpcy5fZmlsdGVyLm9uKFwiY29tcGxldGVcIiwgdGhpcy5fY29tcGxldGUuYmluZCh0aGlzKSk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUucGlwZSh0aGlzLl9maWx0ZXIpO1xuICAgIH0gZWxzZSB7XG4gICAgICBsZXQgcm93U2l6ZSA9XG4gICAgICAgICgodGhpcy5fYml0bWFwSW5mby53aWR0aCAqXG4gICAgICAgICAgdGhpcy5fYml0bWFwSW5mby5icHAgKlxuICAgICAgICAgIHRoaXMuX2JpdG1hcEluZm8uZGVwdGggK1xuICAgICAgICAgIDcpID4+XG4gICAgICAgICAgMykgK1xuICAgICAgICAxO1xuICAgICAgbGV0IGltYWdlU2l6ZSA9IHJvd1NpemUgKiB0aGlzLl9iaXRtYXBJbmZvLmhlaWdodDtcbiAgICAgIGxldCBjaHVua1NpemUgPSBNYXRoLm1heChpbWFnZVNpemUsIHpsaWIuWl9NSU5fQ0hVTkspO1xuXG4gICAgICB0aGlzLl9pbmZsYXRlID0gemxpYi5jcmVhdGVJbmZsYXRlKHsgY2h1bmtTaXplOiBjaHVua1NpemUgfSk7XG4gICAgICBsZXQgbGVmdFRvSW5mbGF0ZSA9IGltYWdlU2l6ZTtcblxuICAgICAgbGV0IGVtaXRFcnJvciA9IHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIik7XG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZXJyb3JcIiwgZnVuY3Rpb24gKGVycikge1xuICAgICAgICBpZiAoIWxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBlbWl0RXJyb3IoZXJyKTtcbiAgICAgIH0pO1xuICAgICAgdGhpcy5fZmlsdGVyLm9uKFwiY29tcGxldGVcIiwgdGhpcy5fY29tcGxldGUuYmluZCh0aGlzKSk7XG5cbiAgICAgIGxldCBmaWx0ZXJXcml0ZSA9IHRoaXMuX2ZpbHRlci53cml0ZS5iaW5kKHRoaXMuX2ZpbHRlcik7XG4gICAgICB0aGlzLl9pbmZsYXRlLm9uKFwiZGF0YVwiLCBmdW5jdGlvbiAoY2h1bmspIHtcbiAgICAgICAgaWYgKCFsZWZ0VG9JbmZsYXRlKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNodW5rLmxlbmd0aCA+IGxlZnRUb0luZmxhdGUpIHtcbiAgICAgICAgICBjaHVuayA9IGNodW5rLnNsaWNlKDAsIGxlZnRUb0luZmxhdGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGVmdFRvSW5mbGF0ZSAtPSBjaHVuay5sZW5ndGg7XG5cbiAgICAgICAgZmlsdGVyV3JpdGUoY2h1bmspO1xuICAgICAgfSk7XG5cbiAgICAgIHRoaXMuX2luZmxhdGUub24oXCJlbmRcIiwgdGhpcy5fZmlsdGVyLmVuZC5iaW5kKHRoaXMuX2ZpbHRlcikpO1xuICAgIH1cbiAgfVxuICB0aGlzLl9pbmZsYXRlLndyaXRlKGRhdGEpO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVNZXRhRGF0YSA9IGZ1bmN0aW9uIChtZXRhRGF0YSkge1xuICB0aGlzLl9tZXRhRGF0YSA9IG1ldGFEYXRhO1xuICB0aGlzLl9iaXRtYXBJbmZvID0gT2JqZWN0LmNyZWF0ZShtZXRhRGF0YSk7XG5cbiAgdGhpcy5fZmlsdGVyID0gbmV3IEZpbHRlckFzeW5jKHRoaXMuX2JpdG1hcEluZm8pO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oYW5kbGVUcmFuc0NvbG9yID0gZnVuY3Rpb24gKHRyYW5zQ29sb3IpIHtcbiAgdGhpcy5fYml0bWFwSW5mby50cmFuc0NvbG9yID0gdHJhbnNDb2xvcjtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5faGFuZGxlUGFsZXR0ZSA9IGZ1bmN0aW9uIChwYWxldHRlKSB7XG4gIHRoaXMuX2JpdG1hcEluZm8ucGFsZXR0ZSA9IHBhbGV0dGU7XG59O1xuXG5QYXJzZXJBc3luYy5wcm90b3R5cGUuX3NpbXBsZVRyYW5zcGFyZW5jeSA9IGZ1bmN0aW9uICgpIHtcbiAgdGhpcy5fbWV0YURhdGEuYWxwaGEgPSB0cnVlO1xufTtcblxuUGFyc2VyQXN5bmMucHJvdG90eXBlLl9oZWFkZXJzRmluaXNoZWQgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIFVwIHVudGlsIHRoaXMgcG9pbnQsIHdlIGRvbid0IGtub3cgaWYgd2UgaGF2ZSBhIHRSTlMgY2h1bmsgKGFscGhhKVxuICAvLyBzbyB3ZSBjYW4ndCBlbWl0IG1ldGFkYXRhIGFueSBlYXJsaWVyXG4gIHRoaXMuZW1pdChcIm1ldGFkYXRhXCIsIHRoaXMuX21ldGFEYXRhKTtcbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5fZmluaXNoZWQgPSBmdW5jdGlvbiAoKSB7XG4gIGlmICh0aGlzLmVycm9yZCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmICghdGhpcy5faW5mbGF0ZSkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIFwiTm8gSW5mbGF0ZSBibG9ja1wiKTtcbiAgfSBlbHNlIHtcbiAgICAvLyBubyBtb3JlIGRhdGEgdG8gaW5mbGF0ZVxuICAgIHRoaXMuX2luZmxhdGUuZW5kKCk7XG4gIH1cbn07XG5cblBhcnNlckFzeW5jLnByb3RvdHlwZS5fY29tcGxldGUgPSBmdW5jdGlvbiAoZmlsdGVyZWREYXRhKSB7XG4gIGlmICh0aGlzLmVycm9yZCkge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGxldCBub3JtYWxpc2VkQml0bWFwRGF0YTtcblxuICB0cnkge1xuICAgIGxldCBiaXRtYXBEYXRhID0gYml0bWFwcGVyLmRhdGFUb0JpdE1hcChmaWx0ZXJlZERhdGEsIHRoaXMuX2JpdG1hcEluZm8pO1xuXG4gICAgbm9ybWFsaXNlZEJpdG1hcERhdGEgPSBmb3JtYXROb3JtYWxpc2VyKFxuICAgICAgYml0bWFwRGF0YSxcbiAgICAgIHRoaXMuX2JpdG1hcEluZm8sXG4gICAgICB0aGlzLl9vcHRpb25zLnNraXBSZXNjYWxlXG4gICAgKTtcbiAgICBiaXRtYXBEYXRhID0gbnVsbDtcbiAgfSBjYXRjaCAoZXgpIHtcbiAgICB0aGlzLl9oYW5kbGVFcnJvcihleCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgdGhpcy5lbWl0KFwicGFyc2VkXCIsIG5vcm1hbGlzZWRCaXRtYXBEYXRhKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGRhdGFJbiwgd2lkdGgsIGhlaWdodCwgb3B0aW9ucykge1xuICBsZXQgb3V0SGFzQWxwaGEgPVxuICAgIFtjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLCBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBXS5pbmRleE9mKFxuICAgICAgb3B0aW9ucy5jb2xvclR5cGVcbiAgICApICE9PSAtMTtcbiAgaWYgKG9wdGlvbnMuY29sb3JUeXBlID09PSBvcHRpb25zLmlucHV0Q29sb3JUeXBlKSB7XG4gICAgbGV0IGJpZ0VuZGlhbiA9IChmdW5jdGlvbiAoKSB7XG4gICAgICBsZXQgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKDIpO1xuICAgICAgbmV3IERhdGFWaWV3KGJ1ZmZlcikuc2V0SW50MTYoMCwgMjU2LCB0cnVlIC8qIGxpdHRsZUVuZGlhbiAqLyk7XG4gICAgICAvLyBJbnQxNkFycmF5IHVzZXMgdGhlIHBsYXRmb3JtJ3MgZW5kaWFubmVzcy5cbiAgICAgIHJldHVybiBuZXcgSW50MTZBcnJheShidWZmZXIpWzBdICE9PSAyNTY7XG4gICAgfSkoKTtcbiAgICAvLyBJZiBubyBuZWVkIHRvIGNvbnZlcnQgdG8gZ3JheXNjYWxlIGFuZCBhbHBoYSBpcyBwcmVzZW50L2Fic2VudCBpbiBib3RoLCB0YWtlIGEgZmFzdCByb3V0ZVxuICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4IHx8IChvcHRpb25zLmJpdERlcHRoID09PSAxNiAmJiBiaWdFbmRpYW4pKSB7XG4gICAgICByZXR1cm4gZGF0YUluO1xuICAgIH1cbiAgfVxuXG4gIC8vIG1hcCB0byBhIFVJbnQxNiBhcnJheSBpZiBkYXRhIGlzIDE2Yml0LCBmaXggZW5kaWFubmVzcyBiZWxvd1xuICBsZXQgZGF0YSA9IG9wdGlvbnMuYml0RGVwdGggIT09IDE2ID8gZGF0YUluIDogbmV3IFVpbnQxNkFycmF5KGRhdGFJbi5idWZmZXIpO1xuXG4gIGxldCBtYXhWYWx1ZSA9IDI1NTtcbiAgbGV0IGluQnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW29wdGlvbnMuaW5wdXRDb2xvclR5cGVdO1xuICBpZiAoaW5CcHAgPT09IDQgJiYgIW9wdGlvbnMuaW5wdXRIYXNBbHBoYSkge1xuICAgIGluQnBwID0gMztcbiAgfVxuICBsZXQgb3V0QnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW29wdGlvbnMuY29sb3JUeXBlXTtcbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDE2KSB7XG4gICAgbWF4VmFsdWUgPSA2NTUzNTtcbiAgICBvdXRCcHAgKj0gMjtcbiAgfVxuICBsZXQgb3V0RGF0YSA9IEJ1ZmZlci5hbGxvYyh3aWR0aCAqIGhlaWdodCAqIG91dEJwcCk7XG5cbiAgbGV0IGluSW5kZXggPSAwO1xuICBsZXQgb3V0SW5kZXggPSAwO1xuXG4gIGxldCBiZ0NvbG9yID0gb3B0aW9ucy5iZ0NvbG9yIHx8IHt9O1xuICBpZiAoYmdDb2xvci5yZWQgPT09IHVuZGVmaW5lZCkge1xuICAgIGJnQ29sb3IucmVkID0gbWF4VmFsdWU7XG4gIH1cbiAgaWYgKGJnQ29sb3IuZ3JlZW4gPT09IHVuZGVmaW5lZCkge1xuICAgIGJnQ29sb3IuZ3JlZW4gPSBtYXhWYWx1ZTtcbiAgfVxuICBpZiAoYmdDb2xvci5ibHVlID09PSB1bmRlZmluZWQpIHtcbiAgICBiZ0NvbG9yLmJsdWUgPSBtYXhWYWx1ZTtcbiAgfVxuXG4gIGZ1bmN0aW9uIGdldFJHQkEoKSB7XG4gICAgbGV0IHJlZDtcbiAgICBsZXQgZ3JlZW47XG4gICAgbGV0IGJsdWU7XG4gICAgbGV0IGFscGhhID0gbWF4VmFsdWU7XG4gICAgc3dpdGNoIChvcHRpb25zLmlucHV0Q29sb3JUeXBlKSB7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEE6XG4gICAgICAgIGFscGhhID0gZGF0YVtpbkluZGV4ICsgM107XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIGJsdWUgPSBkYXRhW2luSW5kZXggKyAyXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1I6XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIGJsdWUgPSBkYXRhW2luSW5kZXggKyAyXTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlIGNvbnN0YW50cy5DT0xPUlRZUEVfQUxQSEE6XG4gICAgICAgIGFscGhhID0gZGF0YVtpbkluZGV4ICsgMV07XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gcmVkO1xuICAgICAgICBibHVlID0gcmVkO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9HUkFZU0NBTEU6XG4gICAgICAgIHJlZCA9IGRhdGFbaW5JbmRleF07XG4gICAgICAgIGdyZWVuID0gcmVkO1xuICAgICAgICBibHVlID0gcmVkO1xuICAgICAgICBicmVhaztcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICBcImlucHV0IGNvbG9yIHR5cGU6XCIgK1xuICAgICAgICAgICAgb3B0aW9ucy5pbnB1dENvbG9yVHlwZSArXG4gICAgICAgICAgICBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICAgICApO1xuICAgIH1cblxuICAgIGlmIChvcHRpb25zLmlucHV0SGFzQWxwaGEpIHtcbiAgICAgIGlmICghb3V0SGFzQWxwaGEpIHtcbiAgICAgICAgYWxwaGEgLz0gbWF4VmFsdWU7XG4gICAgICAgIHJlZCA9IE1hdGgubWluKFxuICAgICAgICAgIE1hdGgubWF4KE1hdGgucm91bmQoKDEgLSBhbHBoYSkgKiBiZ0NvbG9yLnJlZCArIGFscGhhICogcmVkKSwgMCksXG4gICAgICAgICAgbWF4VmFsdWVcbiAgICAgICAgKTtcbiAgICAgICAgZ3JlZW4gPSBNYXRoLm1pbihcbiAgICAgICAgICBNYXRoLm1heChNYXRoLnJvdW5kKCgxIC0gYWxwaGEpICogYmdDb2xvci5ncmVlbiArIGFscGhhICogZ3JlZW4pLCAwKSxcbiAgICAgICAgICBtYXhWYWx1ZVxuICAgICAgICApO1xuICAgICAgICBibHVlID0gTWF0aC5taW4oXG4gICAgICAgICAgTWF0aC5tYXgoTWF0aC5yb3VuZCgoMSAtIGFscGhhKSAqIGJnQ29sb3IuYmx1ZSArIGFscGhhICogYmx1ZSksIDApLFxuICAgICAgICAgIG1heFZhbHVlXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7IHJlZDogcmVkLCBncmVlbjogZ3JlZW4sIGJsdWU6IGJsdWUsIGFscGhhOiBhbHBoYSB9O1xuICB9XG5cbiAgZm9yIChsZXQgeSA9IDA7IHkgPCBoZWlnaHQ7IHkrKykge1xuICAgIGZvciAobGV0IHggPSAwOyB4IDwgd2lkdGg7IHgrKykge1xuICAgICAgbGV0IHJnYmEgPSBnZXRSR0JBKGRhdGEsIGluSW5kZXgpO1xuXG4gICAgICBzd2l0Y2ggKG9wdGlvbnMuY29sb3JUeXBlKSB7XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTpcbiAgICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SOlxuICAgICAgICAgIGlmIChvcHRpb25zLmJpdERlcHRoID09PSA4KSB7XG4gICAgICAgICAgICBvdXREYXRhW291dEluZGV4XSA9IHJnYmEucmVkO1xuICAgICAgICAgICAgb3V0RGF0YVtvdXRJbmRleCArIDFdID0gcmdiYS5ncmVlbjtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAyXSA9IHJnYmEuYmx1ZTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhW291dEluZGV4ICsgM10gPSByZ2JhLmFscGhhO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5yZWQsIG91dEluZGV4KTtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShyZ2JhLmdyZWVuLCBvdXRJbmRleCArIDIpO1xuICAgICAgICAgICAgb3V0RGF0YS53cml0ZVVJbnQxNkJFKHJnYmEuYmx1ZSwgb3V0SW5kZXggKyA0KTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5hbHBoYSwgb3V0SW5kZXggKyA2KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQTpcbiAgICAgICAgY2FzZSBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRToge1xuICAgICAgICAgIC8vIENvbnZlcnQgdG8gZ3JheXNjYWxlIGFuZCBhbHBoYVxuICAgICAgICAgIGxldCBncmF5c2NhbGUgPSAocmdiYS5yZWQgKyByZ2JhLmdyZWVuICsgcmdiYS5ibHVlKSAvIDM7XG4gICAgICAgICAgaWYgKG9wdGlvbnMuYml0RGVwdGggPT09IDgpIHtcbiAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXhdID0gZ3JheXNjYWxlO1xuICAgICAgICAgICAgaWYgKG91dEhhc0FscGhhKSB7XG4gICAgICAgICAgICAgIG91dERhdGFbb3V0SW5kZXggKyAxXSA9IHJnYmEuYWxwaGE7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIG91dERhdGEud3JpdGVVSW50MTZCRShncmF5c2NhbGUsIG91dEluZGV4KTtcbiAgICAgICAgICAgIGlmIChvdXRIYXNBbHBoYSkge1xuICAgICAgICAgICAgICBvdXREYXRhLndyaXRlVUludDE2QkUocmdiYS5hbHBoYSwgb3V0SW5kZXggKyAyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJ1bnJlY29nbmlzZWQgY29sb3IgVHlwZSBcIiArIG9wdGlvbnMuY29sb3JUeXBlKTtcbiAgICAgIH1cblxuICAgICAgaW5JbmRleCArPSBpbkJwcDtcbiAgICAgIG91dEluZGV4ICs9IG91dEJwcDtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gb3V0RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBwYWV0aFByZWRpY3RvciA9IHJlcXVpcmUoXCIuL3BhZXRoLXByZWRpY3RvclwiKTtcblxuZnVuY3Rpb24gZmlsdGVyTm9uZShweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1Bvcykge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHB4RGF0YVtweFBvcyArIHhdO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bU5vbmUocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoKSB7XG4gIGxldCBzdW0gPSAwO1xuICBsZXQgbGVuZ3RoID0gcHhQb3MgKyBieXRlV2lkdGg7XG5cbiAgZm9yIChsZXQgaSA9IHB4UG9zOyBpIDwgbGVuZ3RoOyBpKyspIHtcbiAgICBzdW0gKz0gTWF0aC5hYnMocHhEYXRhW2ldKTtcbiAgfVxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdWIocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCkge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBsZWZ0O1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1TdWIocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB2YWwgPSBweERhdGFbcHhQb3MgKyB4XSAtIGxlZnQ7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmZ1bmN0aW9uIGZpbHRlclVwKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zKSB7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gdXA7XG5cbiAgICByYXdEYXRhW3Jhd1BvcyArIHhdID0gdmFsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bVVwKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCkge1xuICBsZXQgc3VtID0gMDtcbiAgbGV0IGxlbmd0aCA9IHB4UG9zICsgYnl0ZVdpZHRoO1xuICBmb3IgKGxldCB4ID0gcHhQb3M7IHggPCBsZW5ndGg7IHgrKykge1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVt4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVt4XSAtIHVwO1xuXG4gICAgc3VtICs9IE1hdGguYWJzKHZhbCk7XG4gIH1cblxuICByZXR1cm4gc3VtO1xufVxuXG5mdW5jdGlvbiBmaWx0ZXJBdmcocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCByYXdEYXRhLCByYXdQb3MsIGJwcCkge1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gKChsZWZ0ICsgdXApID4+IDEpO1xuXG4gICAgcmF3RGF0YVtyYXdQb3MgKyB4XSA9IHZhbDtcbiAgfVxufVxuXG5mdW5jdGlvbiBmaWx0ZXJTdW1BdmcocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApIHtcbiAgbGV0IHN1bSA9IDA7XG4gIGZvciAobGV0IHggPSAwOyB4IDwgYnl0ZVdpZHRoOyB4KyspIHtcbiAgICBsZXQgbGVmdCA9IHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJwcF0gOiAwO1xuICAgIGxldCB1cCA9IHB4UG9zID4gMCA/IHB4RGF0YVtweFBvcyArIHggLSBieXRlV2lkdGhdIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSAoKGxlZnQgKyB1cCkgPj4gMSk7XG5cbiAgICBzdW0gKz0gTWF0aC5hYnModmFsKTtcbiAgfVxuXG4gIHJldHVybiBzdW07XG59XG5cbmZ1bmN0aW9uIGZpbHRlclBhZXRoKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgcmF3RGF0YSwgcmF3UG9zLCBicHApIHtcbiAgZm9yIChsZXQgeCA9IDA7IHggPCBieXRlV2lkdGg7IHgrKykge1xuICAgIGxldCBsZWZ0ID0geCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnBwXSA6IDA7XG4gICAgbGV0IHVwID0gcHhQb3MgPiAwID8gcHhEYXRhW3B4UG9zICsgeCAtIGJ5dGVXaWR0aF0gOiAwO1xuICAgIGxldCB1cGxlZnQgPVxuICAgICAgcHhQb3MgPiAwICYmIHggPj0gYnBwID8gcHhEYXRhW3B4UG9zICsgeCAtIChieXRlV2lkdGggKyBicHApXSA6IDA7XG4gICAgbGV0IHZhbCA9IHB4RGF0YVtweFBvcyArIHhdIC0gcGFldGhQcmVkaWN0b3IobGVmdCwgdXAsIHVwbGVmdCk7XG5cbiAgICByYXdEYXRhW3Jhd1BvcyArIHhdID0gdmFsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGZpbHRlclN1bVBhZXRoKHB4RGF0YSwgcHhQb3MsIGJ5dGVXaWR0aCwgYnBwKSB7XG4gIGxldCBzdW0gPSAwO1xuICBmb3IgKGxldCB4ID0gMDsgeCA8IGJ5dGVXaWR0aDsgeCsrKSB7XG4gICAgbGV0IGxlZnQgPSB4ID49IGJwcCA/IHB4RGF0YVtweFBvcyArIHggLSBicHBdIDogMDtcbiAgICBsZXQgdXAgPSBweFBvcyA+IDAgPyBweERhdGFbcHhQb3MgKyB4IC0gYnl0ZVdpZHRoXSA6IDA7XG4gICAgbGV0IHVwbGVmdCA9XG4gICAgICBweFBvcyA+IDAgJiYgeCA+PSBicHAgPyBweERhdGFbcHhQb3MgKyB4IC0gKGJ5dGVXaWR0aCArIGJwcCldIDogMDtcbiAgICBsZXQgdmFsID0gcHhEYXRhW3B4UG9zICsgeF0gLSBwYWV0aFByZWRpY3RvcihsZWZ0LCB1cCwgdXBsZWZ0KTtcblxuICAgIHN1bSArPSBNYXRoLmFicyh2YWwpO1xuICB9XG5cbiAgcmV0dXJuIHN1bTtcbn1cblxubGV0IGZpbHRlcnMgPSB7XG4gIDA6IGZpbHRlck5vbmUsXG4gIDE6IGZpbHRlclN1YixcbiAgMjogZmlsdGVyVXAsXG4gIDM6IGZpbHRlckF2ZyxcbiAgNDogZmlsdGVyUGFldGgsXG59O1xuXG5sZXQgZmlsdGVyU3VtcyA9IHtcbiAgMDogZmlsdGVyU3VtTm9uZSxcbiAgMTogZmlsdGVyU3VtU3ViLFxuICAyOiBmaWx0ZXJTdW1VcCxcbiAgMzogZmlsdGVyU3VtQXZnLFxuICA0OiBmaWx0ZXJTdW1QYWV0aCxcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKHB4RGF0YSwgd2lkdGgsIGhlaWdodCwgb3B0aW9ucywgYnBwKSB7XG4gIGxldCBmaWx0ZXJUeXBlcztcbiAgaWYgKCEoXCJmaWx0ZXJUeXBlXCIgaW4gb3B0aW9ucykgfHwgb3B0aW9ucy5maWx0ZXJUeXBlID09PSAtMSkge1xuICAgIGZpbHRlclR5cGVzID0gWzAsIDEsIDIsIDMsIDRdO1xuICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmZpbHRlclR5cGUgPT09IFwibnVtYmVyXCIpIHtcbiAgICBmaWx0ZXJUeXBlcyA9IFtvcHRpb25zLmZpbHRlclR5cGVdO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBmaWx0ZXIgdHlwZXNcIik7XG4gIH1cblxuICBpZiAob3B0aW9ucy5iaXREZXB0aCA9PT0gMTYpIHtcbiAgICBicHAgKj0gMjtcbiAgfVxuICBsZXQgYnl0ZVdpZHRoID0gd2lkdGggKiBicHA7XG4gIGxldCByYXdQb3MgPSAwO1xuICBsZXQgcHhQb3MgPSAwO1xuICBsZXQgcmF3RGF0YSA9IEJ1ZmZlci5hbGxvYygoYnl0ZVdpZHRoICsgMSkgKiBoZWlnaHQpO1xuXG4gIGxldCBzZWwgPSBmaWx0ZXJUeXBlc1swXTtcblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgaWYgKGZpbHRlclR5cGVzLmxlbmd0aCA+IDEpIHtcbiAgICAgIC8vIGZpbmQgYmVzdCBmaWx0ZXIgZm9yIHRoaXMgbGluZSAod2l0aCBsb3dlc3Qgc3VtIG9mIHZhbHVlcylcbiAgICAgIGxldCBtaW4gPSBJbmZpbml0eTtcblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBmaWx0ZXJUeXBlcy5sZW5ndGg7IGkrKykge1xuICAgICAgICBsZXQgc3VtID0gZmlsdGVyU3Vtc1tmaWx0ZXJUeXBlc1tpXV0ocHhEYXRhLCBweFBvcywgYnl0ZVdpZHRoLCBicHApO1xuICAgICAgICBpZiAoc3VtIDwgbWluKSB7XG4gICAgICAgICAgc2VsID0gZmlsdGVyVHlwZXNbaV07XG4gICAgICAgICAgbWluID0gc3VtO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmF3RGF0YVtyYXdQb3NdID0gc2VsO1xuICAgIHJhd1BvcysrO1xuICAgIGZpbHRlcnNbc2VsXShweERhdGEsIHB4UG9zLCBieXRlV2lkdGgsIHJhd0RhdGEsIHJhd1BvcywgYnBwKTtcbiAgICByYXdQb3MgKz0gYnl0ZVdpZHRoO1xuICAgIHB4UG9zICs9IGJ5dGVXaWR0aDtcbiAgfVxuICByZXR1cm4gcmF3RGF0YTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgQ3JjU3RyZWFtID0gcmVxdWlyZShcIi4vY3JjXCIpO1xubGV0IGJpdFBhY2tlciA9IHJlcXVpcmUoXCIuL2JpdHBhY2tlclwiKTtcbmxldCBmaWx0ZXIgPSByZXF1aXJlKFwiLi9maWx0ZXItcGFja1wiKTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5cbmxldCBQYWNrZXIgPSAobW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbiAob3B0aW9ucykge1xuICB0aGlzLl9vcHRpb25zID0gb3B0aW9ucztcblxuICBvcHRpb25zLmRlZmxhdGVDaHVua1NpemUgPSBvcHRpb25zLmRlZmxhdGVDaHVua1NpemUgfHwgMzIgKiAxMDI0O1xuICBvcHRpb25zLmRlZmxhdGVMZXZlbCA9XG4gICAgb3B0aW9ucy5kZWZsYXRlTGV2ZWwgIT0gbnVsbCA/IG9wdGlvbnMuZGVmbGF0ZUxldmVsIDogOTtcbiAgb3B0aW9ucy5kZWZsYXRlU3RyYXRlZ3kgPVxuICAgIG9wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5ICE9IG51bGwgPyBvcHRpb25zLmRlZmxhdGVTdHJhdGVneSA6IDM7XG4gIG9wdGlvbnMuaW5wdXRIYXNBbHBoYSA9XG4gICAgb3B0aW9ucy5pbnB1dEhhc0FscGhhICE9IG51bGwgPyBvcHRpb25zLmlucHV0SGFzQWxwaGEgOiB0cnVlO1xuICBvcHRpb25zLmRlZmxhdGVGYWN0b3J5ID0gb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSB8fCB6bGliLmNyZWF0ZURlZmxhdGU7XG4gIG9wdGlvbnMuYml0RGVwdGggPSBvcHRpb25zLmJpdERlcHRoIHx8IDg7XG4gIC8vIFRoaXMgaXMgb3V0cHV0Q29sb3JUeXBlXG4gIG9wdGlvbnMuY29sb3JUeXBlID1cbiAgICB0eXBlb2Ygb3B0aW9ucy5jb2xvclR5cGUgPT09IFwibnVtYmVyXCJcbiAgICAgID8gb3B0aW9ucy5jb2xvclR5cGVcbiAgICAgIDogY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUl9BTFBIQTtcbiAgb3B0aW9ucy5pbnB1dENvbG9yVHlwZSA9XG4gICAgdHlwZW9mIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgPT09IFwibnVtYmVyXCJcbiAgICAgID8gb3B0aW9ucy5pbnB1dENvbG9yVHlwZVxuICAgICAgOiBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBO1xuXG4gIGlmIChcbiAgICBbXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0dSQVlTQ0FMRSxcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1IsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0NPTE9SX0FMUEhBLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9BTFBIQSxcbiAgICBdLmluZGV4T2Yob3B0aW9ucy5jb2xvclR5cGUpID09PSAtMVxuICApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIm9wdGlvbiBjb2xvciB0eXBlOlwiICsgb3B0aW9ucy5jb2xvclR5cGUgKyBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICk7XG4gIH1cbiAgaWYgKFxuICAgIFtcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfR1JBWVNDQUxFLFxuICAgICAgY29uc3RhbnRzLkNPTE9SVFlQRV9DT0xPUixcbiAgICAgIGNvbnN0YW50cy5DT0xPUlRZUEVfQ09MT1JfQUxQSEEsXG4gICAgICBjb25zdGFudHMuQ09MT1JUWVBFX0FMUEhBLFxuICAgIF0uaW5kZXhPZihvcHRpb25zLmlucHV0Q29sb3JUeXBlKSA9PT0gLTFcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJvcHRpb24gaW5wdXQgY29sb3IgdHlwZTpcIiArXG4gICAgICAgIG9wdGlvbnMuaW5wdXRDb2xvclR5cGUgK1xuICAgICAgICBcIiBpcyBub3Qgc3VwcG9ydGVkIGF0IHByZXNlbnRcIlxuICAgICk7XG4gIH1cbiAgaWYgKG9wdGlvbnMuYml0RGVwdGggIT09IDggJiYgb3B0aW9ucy5iaXREZXB0aCAhPT0gMTYpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIm9wdGlvbiBiaXQgZGVwdGg6XCIgKyBvcHRpb25zLmJpdERlcHRoICsgXCIgaXMgbm90IHN1cHBvcnRlZCBhdCBwcmVzZW50XCJcbiAgICApO1xuICB9XG59KTtcblxuUGFja2VyLnByb3RvdHlwZS5nZXREZWZsYXRlT3B0aW9ucyA9IGZ1bmN0aW9uICgpIHtcbiAgcmV0dXJuIHtcbiAgICBjaHVua1NpemU6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZUNodW5rU2l6ZSxcbiAgICBsZXZlbDogdGhpcy5fb3B0aW9ucy5kZWZsYXRlTGV2ZWwsXG4gICAgc3RyYXRlZ3k6IHRoaXMuX29wdGlvbnMuZGVmbGF0ZVN0cmF0ZWd5LFxuICB9O1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5jcmVhdGVEZWZsYXRlID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fb3B0aW9ucy5kZWZsYXRlRmFjdG9yeSh0aGlzLmdldERlZmxhdGVPcHRpb25zKCkpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5maWx0ZXJEYXRhID0gZnVuY3Rpb24gKGRhdGEsIHdpZHRoLCBoZWlnaHQpIHtcbiAgLy8gY29udmVydCB0byBjb3JyZWN0IGZvcm1hdCBmb3IgZmlsdGVyaW5nIChlLmcuIHJpZ2h0IGJwcCBhbmQgYml0IGRlcHRoKVxuICBsZXQgcGFja2VkRGF0YSA9IGJpdFBhY2tlcihkYXRhLCB3aWR0aCwgaGVpZ2h0LCB0aGlzLl9vcHRpb25zKTtcblxuICAvLyBmaWx0ZXIgcGl4ZWwgZGF0YVxuICBsZXQgYnBwID0gY29uc3RhbnRzLkNPTE9SVFlQRV9UT19CUFBfTUFQW3RoaXMuX29wdGlvbnMuY29sb3JUeXBlXTtcbiAgbGV0IGZpbHRlcmVkRGF0YSA9IGZpbHRlcihwYWNrZWREYXRhLCB3aWR0aCwgaGVpZ2h0LCB0aGlzLl9vcHRpb25zLCBicHApO1xuICByZXR1cm4gZmlsdGVyZWREYXRhO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5fcGFja0NodW5rID0gZnVuY3Rpb24gKHR5cGUsIGRhdGEpIHtcbiAgbGV0IGxlbiA9IGRhdGEgPyBkYXRhLmxlbmd0aCA6IDA7XG4gIGxldCBidWYgPSBCdWZmZXIuYWxsb2MobGVuICsgMTIpO1xuXG4gIGJ1Zi53cml0ZVVJbnQzMkJFKGxlbiwgMCk7XG4gIGJ1Zi53cml0ZVVJbnQzMkJFKHR5cGUsIDQpO1xuXG4gIGlmIChkYXRhKSB7XG4gICAgZGF0YS5jb3B5KGJ1ZiwgOCk7XG4gIH1cblxuICBidWYud3JpdGVJbnQzMkJFKFxuICAgIENyY1N0cmVhbS5jcmMzMihidWYuc2xpY2UoNCwgYnVmLmxlbmd0aCAtIDQpKSxcbiAgICBidWYubGVuZ3RoIC0gNFxuICApO1xuICByZXR1cm4gYnVmO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrR0FNQSA9IGZ1bmN0aW9uIChnYW1tYSkge1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKDQpO1xuICBidWYud3JpdGVVSW50MzJCRShNYXRoLmZsb29yKGdhbW1hICogY29uc3RhbnRzLkdBTU1BX0RJVklTSU9OKSwgMCk7XG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfZ0FNQSwgYnVmKTtcbn07XG5cblBhY2tlci5wcm90b3R5cGUucGFja0lIRFIgPSBmdW5jdGlvbiAod2lkdGgsIGhlaWdodCkge1xuICBsZXQgYnVmID0gQnVmZmVyLmFsbG9jKDEzKTtcbiAgYnVmLndyaXRlVUludDMyQkUod2lkdGgsIDApO1xuICBidWYud3JpdGVVSW50MzJCRShoZWlnaHQsIDQpO1xuICBidWZbOF0gPSB0aGlzLl9vcHRpb25zLmJpdERlcHRoOyAvLyBCaXQgZGVwdGhcbiAgYnVmWzldID0gdGhpcy5fb3B0aW9ucy5jb2xvclR5cGU7IC8vIGNvbG9yVHlwZVxuICBidWZbMTBdID0gMDsgLy8gY29tcHJlc3Npb25cbiAgYnVmWzExXSA9IDA7IC8vIGZpbHRlclxuICBidWZbMTJdID0gMDsgLy8gaW50ZXJsYWNlXG5cbiAgcmV0dXJuIHRoaXMuX3BhY2tDaHVuayhjb25zdGFudHMuVFlQRV9JSERSLCBidWYpO1xufTtcblxuUGFja2VyLnByb3RvdHlwZS5wYWNrSURBVCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHJldHVybiB0aGlzLl9wYWNrQ2h1bmsoY29uc3RhbnRzLlRZUEVfSURBVCwgZGF0YSk7XG59O1xuXG5QYWNrZXIucHJvdG90eXBlLnBhY2tJRU5EID0gZnVuY3Rpb24gKCkge1xuICByZXR1cm4gdGhpcy5fcGFja0NodW5rKGNvbnN0YW50cy5UWVBFX0lFTkQsIG51bGwpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xubGV0IGNvbnN0YW50cyA9IHJlcXVpcmUoXCIuL2NvbnN0YW50c1wiKTtcbmxldCBQYWNrZXIgPSByZXF1aXJlKFwiLi9wYWNrZXJcIik7XG5cbmxldCBQYWNrZXJBc3luYyA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChvcHQpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgbGV0IG9wdGlvbnMgPSBvcHQgfHwge307XG5cbiAgdGhpcy5fcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcbiAgdGhpcy5fZGVmbGF0ZSA9IHRoaXMuX3BhY2tlci5jcmVhdGVEZWZsYXRlKCk7XG5cbiAgdGhpcy5yZWFkYWJsZSA9IHRydWU7XG59KTtcbnV0aWwuaW5oZXJpdHMoUGFja2VyQXN5bmMsIFN0cmVhbSk7XG5cblBhY2tlckFzeW5jLnByb3RvdHlwZS5wYWNrID0gZnVuY3Rpb24gKGRhdGEsIHdpZHRoLCBoZWlnaHQsIGdhbW1hKSB7XG4gIC8vIFNpZ25hdHVyZVxuICB0aGlzLmVtaXQoXCJkYXRhXCIsIEJ1ZmZlci5mcm9tKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFKSk7XG4gIHRoaXMuZW1pdChcImRhdGFcIiwgdGhpcy5fcGFja2VyLnBhY2tJSERSKHdpZHRoLCBoZWlnaHQpKTtcblxuICBpZiAoZ2FtbWEpIHtcbiAgICB0aGlzLmVtaXQoXCJkYXRhXCIsIHRoaXMuX3BhY2tlci5wYWNrR0FNQShnYW1tYSkpO1xuICB9XG5cbiAgbGV0IGZpbHRlcmVkRGF0YSA9IHRoaXMuX3BhY2tlci5maWx0ZXJEYXRhKGRhdGEsIHdpZHRoLCBoZWlnaHQpO1xuXG4gIC8vIGNvbXByZXNzIGl0XG4gIHRoaXMuX2RlZmxhdGUub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcblxuICB0aGlzLl9kZWZsYXRlLm9uKFxuICAgIFwiZGF0YVwiLFxuICAgIGZ1bmN0aW9uIChjb21wcmVzc2VkRGF0YSkge1xuICAgICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0lEQVQoY29tcHJlc3NlZERhdGEpKTtcbiAgICB9LmJpbmQodGhpcylcbiAgKTtcblxuICB0aGlzLl9kZWZsYXRlLm9uKFxuICAgIFwiZW5kXCIsXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5lbWl0KFwiZGF0YVwiLCB0aGlzLl9wYWNrZXIucGFja0lFTkQoKSk7XG4gICAgICB0aGlzLmVtaXQoXCJlbmRcIik7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgdGhpcy5fZGVmbGF0ZS5lbmQoZmlsdGVyZWREYXRhKTtcbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBhc3NlcnQgPSByZXF1aXJlKFwiYXNzZXJ0XCIpLm9rO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCB1dGlsID0gcmVxdWlyZShcInV0aWxcIik7XG5cbmxldCBrTWF4TGVuZ3RoID0gcmVxdWlyZShcImJ1ZmZlclwiKS5rTWF4TGVuZ3RoO1xuXG5mdW5jdGlvbiBJbmZsYXRlKG9wdHMpIHtcbiAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIEluZmxhdGUpKSB7XG4gICAgcmV0dXJuIG5ldyBJbmZsYXRlKG9wdHMpO1xuICB9XG5cbiAgaWYgKG9wdHMgJiYgb3B0cy5jaHVua1NpemUgPCB6bGliLlpfTUlOX0NIVU5LKSB7XG4gICAgb3B0cy5jaHVua1NpemUgPSB6bGliLlpfTUlOX0NIVU5LO1xuICB9XG5cbiAgemxpYi5JbmZsYXRlLmNhbGwodGhpcywgb3B0cyk7XG5cbiAgLy8gTm9kZSA4IC0tPiA5IGNvbXBhdGliaWxpdHkgY2hlY2tcbiAgdGhpcy5fb2Zmc2V0ID0gdGhpcy5fb2Zmc2V0ID09PSB1bmRlZmluZWQgPyB0aGlzLl9vdXRPZmZzZXQgOiB0aGlzLl9vZmZzZXQ7XG4gIHRoaXMuX2J1ZmZlciA9IHRoaXMuX2J1ZmZlciB8fCB0aGlzLl9vdXRCdWZmZXI7XG5cbiAgaWYgKG9wdHMgJiYgb3B0cy5tYXhMZW5ndGggIT0gbnVsbCkge1xuICAgIHRoaXMuX21heExlbmd0aCA9IG9wdHMubWF4TGVuZ3RoO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUluZmxhdGUob3B0cykge1xuICByZXR1cm4gbmV3IEluZmxhdGUob3B0cyk7XG59XG5cbmZ1bmN0aW9uIF9jbG9zZShlbmdpbmUsIGNhbGxiYWNrKSB7XG4gIGlmIChjYWxsYmFjaykge1xuICAgIHByb2Nlc3MubmV4dFRpY2soY2FsbGJhY2spO1xuICB9XG5cbiAgLy8gQ2FsbGVyIG1heSBpbnZva2UgLmNsb3NlIGFmdGVyIGEgemxpYiBlcnJvciAod2hpY2ggd2lsbCBudWxsIF9oYW5kbGUpLlxuICBpZiAoIWVuZ2luZS5faGFuZGxlKSB7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZW5naW5lLl9oYW5kbGUuY2xvc2UoKTtcbiAgZW5naW5lLl9oYW5kbGUgPSBudWxsO1xufVxuXG5JbmZsYXRlLnByb3RvdHlwZS5fcHJvY2Vzc0NodW5rID0gZnVuY3Rpb24gKGNodW5rLCBmbHVzaEZsYWcsIGFzeW5jQ2IpIHtcbiAgaWYgKHR5cGVvZiBhc3luY0NiID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICByZXR1cm4gemxpYi5JbmZsYXRlLl9wcm9jZXNzQ2h1bmsuY2FsbCh0aGlzLCBjaHVuaywgZmx1c2hGbGFnLCBhc3luY0NiKTtcbiAgfVxuXG4gIGxldCBzZWxmID0gdGhpcztcblxuICBsZXQgYXZhaWxJbkJlZm9yZSA9IGNodW5rICYmIGNodW5rLmxlbmd0aDtcbiAgbGV0IGF2YWlsT3V0QmVmb3JlID0gdGhpcy5fY2h1bmtTaXplIC0gdGhpcy5fb2Zmc2V0O1xuICBsZXQgbGVmdFRvSW5mbGF0ZSA9IHRoaXMuX21heExlbmd0aDtcbiAgbGV0IGluT2ZmID0gMDtcblxuICBsZXQgYnVmZmVycyA9IFtdO1xuICBsZXQgbnJlYWQgPSAwO1xuXG4gIGxldCBlcnJvcjtcbiAgdGhpcy5vbihcImVycm9yXCIsIGZ1bmN0aW9uIChlcnIpIHtcbiAgICBlcnJvciA9IGVycjtcbiAgfSk7XG5cbiAgZnVuY3Rpb24gaGFuZGxlQ2h1bmsoYXZhaWxJbkFmdGVyLCBhdmFpbE91dEFmdGVyKSB7XG4gICAgaWYgKHNlbGYuX2hhZEVycm9yKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbGV0IGhhdmUgPSBhdmFpbE91dEJlZm9yZSAtIGF2YWlsT3V0QWZ0ZXI7XG4gICAgYXNzZXJ0KGhhdmUgPj0gMCwgXCJoYXZlIHNob3VsZCBub3QgZ28gZG93blwiKTtcblxuICAgIGlmIChoYXZlID4gMCkge1xuICAgICAgbGV0IG91dCA9IHNlbGYuX2J1ZmZlci5zbGljZShzZWxmLl9vZmZzZXQsIHNlbGYuX29mZnNldCArIGhhdmUpO1xuICAgICAgc2VsZi5fb2Zmc2V0ICs9IGhhdmU7XG5cbiAgICAgIGlmIChvdXQubGVuZ3RoID4gbGVmdFRvSW5mbGF0ZSkge1xuICAgICAgICBvdXQgPSBvdXQuc2xpY2UoMCwgbGVmdFRvSW5mbGF0ZSk7XG4gICAgICB9XG5cbiAgICAgIGJ1ZmZlcnMucHVzaChvdXQpO1xuICAgICAgbnJlYWQgKz0gb3V0Lmxlbmd0aDtcbiAgICAgIGxlZnRUb0luZmxhdGUgLT0gb3V0Lmxlbmd0aDtcblxuICAgICAgaWYgKGxlZnRUb0luZmxhdGUgPT09IDApIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChhdmFpbE91dEFmdGVyID09PSAwIHx8IHNlbGYuX29mZnNldCA+PSBzZWxmLl9jaHVua1NpemUpIHtcbiAgICAgIGF2YWlsT3V0QmVmb3JlID0gc2VsZi5fY2h1bmtTaXplO1xuICAgICAgc2VsZi5fb2Zmc2V0ID0gMDtcbiAgICAgIHNlbGYuX2J1ZmZlciA9IEJ1ZmZlci5hbGxvY1Vuc2FmZShzZWxmLl9jaHVua1NpemUpO1xuICAgIH1cblxuICAgIGlmIChhdmFpbE91dEFmdGVyID09PSAwKSB7XG4gICAgICBpbk9mZiArPSBhdmFpbEluQmVmb3JlIC0gYXZhaWxJbkFmdGVyO1xuICAgICAgYXZhaWxJbkJlZm9yZSA9IGF2YWlsSW5BZnRlcjtcblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgYXNzZXJ0KHRoaXMuX2hhbmRsZSwgXCJ6bGliIGJpbmRpbmcgY2xvc2VkXCIpO1xuICBsZXQgcmVzO1xuICBkbyB7XG4gICAgcmVzID0gdGhpcy5faGFuZGxlLndyaXRlU3luYyhcbiAgICAgIGZsdXNoRmxhZyxcbiAgICAgIGNodW5rLCAvLyBpblxuICAgICAgaW5PZmYsIC8vIGluX29mZlxuICAgICAgYXZhaWxJbkJlZm9yZSwgLy8gaW5fbGVuXG4gICAgICB0aGlzLl9idWZmZXIsIC8vIG91dFxuICAgICAgdGhpcy5fb2Zmc2V0LCAvL291dF9vZmZcbiAgICAgIGF2YWlsT3V0QmVmb3JlXG4gICAgKTsgLy8gb3V0X2xlblxuICAgIC8vIE5vZGUgOCAtLT4gOSBjb21wYXRpYmlsaXR5IGNoZWNrXG4gICAgcmVzID0gcmVzIHx8IHRoaXMuX3dyaXRlU3RhdGU7XG4gIH0gd2hpbGUgKCF0aGlzLl9oYWRFcnJvciAmJiBoYW5kbGVDaHVuayhyZXNbMF0sIHJlc1sxXSkpO1xuXG4gIGlmICh0aGlzLl9oYWRFcnJvcikge1xuICAgIHRocm93IGVycm9yO1xuICB9XG5cbiAgaWYgKG5yZWFkID49IGtNYXhMZW5ndGgpIHtcbiAgICBfY2xvc2UodGhpcyk7XG4gICAgdGhyb3cgbmV3IFJhbmdlRXJyb3IoXG4gICAgICBcIkNhbm5vdCBjcmVhdGUgZmluYWwgQnVmZmVyLiBJdCB3b3VsZCBiZSBsYXJnZXIgdGhhbiAweFwiICtcbiAgICAgICAga01heExlbmd0aC50b1N0cmluZygxNikgK1xuICAgICAgICBcIiBieXRlc1wiXG4gICAgKTtcbiAgfVxuXG4gIGxldCBidWYgPSBCdWZmZXIuY29uY2F0KGJ1ZmZlcnMsIG5yZWFkKTtcbiAgX2Nsb3NlKHRoaXMpO1xuXG4gIHJldHVybiBidWY7XG59O1xuXG51dGlsLmluaGVyaXRzKEluZmxhdGUsIHpsaWIuSW5mbGF0ZSk7XG5cbmZ1bmN0aW9uIHpsaWJCdWZmZXJTeW5jKGVuZ2luZSwgYnVmZmVyKSB7XG4gIGlmICh0eXBlb2YgYnVmZmVyID09PSBcInN0cmluZ1wiKSB7XG4gICAgYnVmZmVyID0gQnVmZmVyLmZyb20oYnVmZmVyKTtcbiAgfVxuICBpZiAoIShidWZmZXIgaW5zdGFuY2VvZiBCdWZmZXIpKSB7XG4gICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIk5vdCBhIHN0cmluZyBvciBidWZmZXJcIik7XG4gIH1cblxuICBsZXQgZmx1c2hGbGFnID0gZW5naW5lLl9maW5pc2hGbHVzaEZsYWc7XG4gIGlmIChmbHVzaEZsYWcgPT0gbnVsbCkge1xuICAgIGZsdXNoRmxhZyA9IHpsaWIuWl9GSU5JU0g7XG4gIH1cblxuICByZXR1cm4gZW5naW5lLl9wcm9jZXNzQ2h1bmsoYnVmZmVyLCBmbHVzaEZsYWcpO1xufVxuXG5mdW5jdGlvbiBpbmZsYXRlU3luYyhidWZmZXIsIG9wdHMpIHtcbiAgcmV0dXJuIHpsaWJCdWZmZXJTeW5jKG5ldyBJbmZsYXRlKG9wdHMpLCBidWZmZXIpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IGV4cG9ydHMgPSBpbmZsYXRlU3luYztcbmV4cG9ydHMuSW5mbGF0ZSA9IEluZmxhdGU7XG5leHBvcnRzLmNyZWF0ZUluZmxhdGUgPSBjcmVhdGVJbmZsYXRlO1xuZXhwb3J0cy5pbmZsYXRlU3luYyA9IGluZmxhdGVTeW5jO1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgU3luY1JlYWRlciA9IChtb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChidWZmZXIpIHtcbiAgdGhpcy5fYnVmZmVyID0gYnVmZmVyO1xuICB0aGlzLl9yZWFkcyA9IFtdO1xufSk7XG5cblN5bmNSZWFkZXIucHJvdG90eXBlLnJlYWQgPSBmdW5jdGlvbiAobGVuZ3RoLCBjYWxsYmFjaykge1xuICB0aGlzLl9yZWFkcy5wdXNoKHtcbiAgICBsZW5ndGg6IE1hdGguYWJzKGxlbmd0aCksIC8vIGlmIGxlbmd0aCA8IDAgdGhlbiBhdCBtb3N0IHRoaXMgbGVuZ3RoXG4gICAgYWxsb3dMZXNzOiBsZW5ndGggPCAwLFxuICAgIGZ1bmM6IGNhbGxiYWNrLFxuICB9KTtcbn07XG5cblN5bmNSZWFkZXIucHJvdG90eXBlLnByb2Nlc3MgPSBmdW5jdGlvbiAoKSB7XG4gIC8vIGFzIGxvbmcgYXMgdGhlcmUgaXMgYW55IGRhdGEgYW5kIHJlYWQgcmVxdWVzdHNcbiAgd2hpbGUgKHRoaXMuX3JlYWRzLmxlbmd0aCA+IDAgJiYgdGhpcy5fYnVmZmVyLmxlbmd0aCkge1xuICAgIGxldCByZWFkID0gdGhpcy5fcmVhZHNbMF07XG5cbiAgICBpZiAoXG4gICAgICB0aGlzLl9idWZmZXIubGVuZ3RoICYmXG4gICAgICAodGhpcy5fYnVmZmVyLmxlbmd0aCA+PSByZWFkLmxlbmd0aCB8fCByZWFkLmFsbG93TGVzcylcbiAgICApIHtcbiAgICAgIC8vIG9rIHRoZXJlIGlzIGFueSBkYXRhIHNvIHRoYXQgd2UgY2FuIHNhdGlzZnkgdGhpcyByZXF1ZXN0XG4gICAgICB0aGlzLl9yZWFkcy5zaGlmdCgpOyAvLyA9PSByZWFkXG5cbiAgICAgIGxldCBidWYgPSB0aGlzLl9idWZmZXI7XG5cbiAgICAgIHRoaXMuX2J1ZmZlciA9IGJ1Zi5zbGljZShyZWFkLmxlbmd0aCk7XG5cbiAgICAgIHJlYWQuZnVuYy5jYWxsKHRoaXMsIGJ1Zi5zbGljZSgwLCByZWFkLmxlbmd0aCkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBicmVhaztcbiAgICB9XG4gIH1cblxuICBpZiAodGhpcy5fcmVhZHMubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIlRoZXJlIGFyZSBzb21lIHJlYWQgcmVxdWVzdHMgd2FpdG5nIG9uIGZpbmlzaGVkIHN0cmVhbVwiKTtcbiAgfVxuXG4gIGlmICh0aGlzLl9idWZmZXIubGVuZ3RoID4gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcInVucmVjb2duaXNlZCBjb250ZW50IGF0IGVuZCBvZiBzdHJlYW1cIik7XG4gIH1cbn07XG4iLCAiXCJ1c2Ugc3RyaWN0XCI7XG5cbmxldCBTeW5jUmVhZGVyID0gcmVxdWlyZShcIi4vc3luYy1yZWFkZXJcIik7XG5sZXQgRmlsdGVyID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlXCIpO1xuXG5leHBvcnRzLnByb2Nlc3MgPSBmdW5jdGlvbiAoaW5CdWZmZXIsIGJpdG1hcEluZm8pIHtcbiAgbGV0IG91dEJ1ZmZlcnMgPSBbXTtcbiAgbGV0IHJlYWRlciA9IG5ldyBTeW5jUmVhZGVyKGluQnVmZmVyKTtcbiAgbGV0IGZpbHRlciA9IG5ldyBGaWx0ZXIoYml0bWFwSW5mbywge1xuICAgIHJlYWQ6IHJlYWRlci5yZWFkLmJpbmQocmVhZGVyKSxcbiAgICB3cml0ZTogZnVuY3Rpb24gKGJ1ZmZlclBhcnQpIHtcbiAgICAgIG91dEJ1ZmZlcnMucHVzaChidWZmZXJQYXJ0KTtcbiAgICB9LFxuICAgIGNvbXBsZXRlOiBmdW5jdGlvbiAoKSB7fSxcbiAgfSk7XG5cbiAgZmlsdGVyLnN0YXJ0KCk7XG4gIHJlYWRlci5wcm9jZXNzKCk7XG5cbiAgcmV0dXJuIEJ1ZmZlci5jb25jYXQob3V0QnVmZmVycyk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgaGFzU3luY1psaWIgPSB0cnVlO1xubGV0IHpsaWIgPSByZXF1aXJlKFwiemxpYlwiKTtcbmxldCBpbmZsYXRlU3luYyA9IHJlcXVpcmUoXCIuL3N5bmMtaW5mbGF0ZVwiKTtcbmlmICghemxpYi5kZWZsYXRlU3luYykge1xuICBoYXNTeW5jWmxpYiA9IGZhbHNlO1xufVxubGV0IFN5bmNSZWFkZXIgPSByZXF1aXJlKFwiLi9zeW5jLXJlYWRlclwiKTtcbmxldCBGaWx0ZXJTeW5jID0gcmVxdWlyZShcIi4vZmlsdGVyLXBhcnNlLXN5bmNcIik7XG5sZXQgUGFyc2VyID0gcmVxdWlyZShcIi4vcGFyc2VyXCIpO1xubGV0IGJpdG1hcHBlciA9IHJlcXVpcmUoXCIuL2JpdG1hcHBlclwiKTtcbmxldCBmb3JtYXROb3JtYWxpc2VyID0gcmVxdWlyZShcIi4vZm9ybWF0LW5vcm1hbGlzZXJcIik7XG5cbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKGJ1ZmZlciwgb3B0aW9ucykge1xuICBpZiAoIWhhc1N5bmNabGliKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgXCJUbyB1c2UgdGhlIHN5bmMgY2FwYWJpbGl0eSBvZiB0aGlzIGxpYnJhcnkgaW4gb2xkIG5vZGUgdmVyc2lvbnMsIHBsZWFzZSBwaW4gcG5nanMgdG8gdjIuMy4wXCJcbiAgICApO1xuICB9XG5cbiAgbGV0IGVycjtcbiAgZnVuY3Rpb24gaGFuZGxlRXJyb3IoX2Vycl8pIHtcbiAgICBlcnIgPSBfZXJyXztcbiAgfVxuXG4gIGxldCBtZXRhRGF0YTtcbiAgZnVuY3Rpb24gaGFuZGxlTWV0YURhdGEoX21ldGFEYXRhXykge1xuICAgIG1ldGFEYXRhID0gX21ldGFEYXRhXztcbiAgfVxuXG4gIGZ1bmN0aW9uIGhhbmRsZVRyYW5zQ29sb3IodHJhbnNDb2xvcikge1xuICAgIG1ldGFEYXRhLnRyYW5zQ29sb3IgPSB0cmFuc0NvbG9yO1xuICB9XG5cbiAgZnVuY3Rpb24gaGFuZGxlUGFsZXR0ZShwYWxldHRlKSB7XG4gICAgbWV0YURhdGEucGFsZXR0ZSA9IHBhbGV0dGU7XG4gIH1cblxuICBmdW5jdGlvbiBoYW5kbGVTaW1wbGVUcmFuc3BhcmVuY3koKSB7XG4gICAgbWV0YURhdGEuYWxwaGEgPSB0cnVlO1xuICB9XG5cbiAgbGV0IGdhbW1hO1xuICBmdW5jdGlvbiBoYW5kbGVHYW1tYShfZ2FtbWFfKSB7XG4gICAgZ2FtbWEgPSBfZ2FtbWFfO1xuICB9XG5cbiAgbGV0IGluZmxhdGVEYXRhTGlzdCA9IFtdO1xuICBmdW5jdGlvbiBoYW5kbGVJbmZsYXRlRGF0YShpbmZsYXRlZERhdGEpIHtcbiAgICBpbmZsYXRlRGF0YUxpc3QucHVzaChpbmZsYXRlZERhdGEpO1xuICB9XG5cbiAgbGV0IHJlYWRlciA9IG5ldyBTeW5jUmVhZGVyKGJ1ZmZlcik7XG5cbiAgbGV0IHBhcnNlciA9IG5ldyBQYXJzZXIob3B0aW9ucywge1xuICAgIHJlYWQ6IHJlYWRlci5yZWFkLmJpbmQocmVhZGVyKSxcbiAgICBlcnJvcjogaGFuZGxlRXJyb3IsXG4gICAgbWV0YWRhdGE6IGhhbmRsZU1ldGFEYXRhLFxuICAgIGdhbW1hOiBoYW5kbGVHYW1tYSxcbiAgICBwYWxldHRlOiBoYW5kbGVQYWxldHRlLFxuICAgIHRyYW5zQ29sb3I6IGhhbmRsZVRyYW5zQ29sb3IsXG4gICAgaW5mbGF0ZURhdGE6IGhhbmRsZUluZmxhdGVEYXRhLFxuICAgIHNpbXBsZVRyYW5zcGFyZW5jeTogaGFuZGxlU2ltcGxlVHJhbnNwYXJlbmN5LFxuICB9KTtcblxuICBwYXJzZXIuc3RhcnQoKTtcbiAgcmVhZGVyLnByb2Nlc3MoKTtcblxuICBpZiAoZXJyKSB7XG4gICAgdGhyb3cgZXJyO1xuICB9XG5cbiAgLy9qb2luIHRvZ2V0aGVyIHRoZSBpbmZsYXRlIGRhdGFzXG4gIGxldCBpbmZsYXRlRGF0YSA9IEJ1ZmZlci5jb25jYXQoaW5mbGF0ZURhdGFMaXN0KTtcbiAgaW5mbGF0ZURhdGFMaXN0Lmxlbmd0aCA9IDA7XG5cbiAgbGV0IGluZmxhdGVkRGF0YTtcbiAgaWYgKG1ldGFEYXRhLmludGVybGFjZSkge1xuICAgIGluZmxhdGVkRGF0YSA9IHpsaWIuaW5mbGF0ZVN5bmMoaW5mbGF0ZURhdGEpO1xuICB9IGVsc2Uge1xuICAgIGxldCByb3dTaXplID1cbiAgICAgICgobWV0YURhdGEud2lkdGggKiBtZXRhRGF0YS5icHAgKiBtZXRhRGF0YS5kZXB0aCArIDcpID4+IDMpICsgMTtcbiAgICBsZXQgaW1hZ2VTaXplID0gcm93U2l6ZSAqIG1ldGFEYXRhLmhlaWdodDtcbiAgICBpbmZsYXRlZERhdGEgPSBpbmZsYXRlU3luYyhpbmZsYXRlRGF0YSwge1xuICAgICAgY2h1bmtTaXplOiBpbWFnZVNpemUsXG4gICAgICBtYXhMZW5ndGg6IGltYWdlU2l6ZSxcbiAgICB9KTtcbiAgfVxuICBpbmZsYXRlRGF0YSA9IG51bGw7XG5cbiAgaWYgKCFpbmZsYXRlZERhdGEgfHwgIWluZmxhdGVkRGF0YS5sZW5ndGgpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJiYWQgcG5nIC0gaW52YWxpZCBpbmZsYXRlIGRhdGEgcmVzcG9uc2VcIik7XG4gIH1cblxuICBsZXQgdW5maWx0ZXJlZERhdGEgPSBGaWx0ZXJTeW5jLnByb2Nlc3MoaW5mbGF0ZWREYXRhLCBtZXRhRGF0YSk7XG4gIGluZmxhdGVEYXRhID0gbnVsbDtcblxuICBsZXQgYml0bWFwRGF0YSA9IGJpdG1hcHBlci5kYXRhVG9CaXRNYXAodW5maWx0ZXJlZERhdGEsIG1ldGFEYXRhKTtcbiAgdW5maWx0ZXJlZERhdGEgPSBudWxsO1xuXG4gIGxldCBub3JtYWxpc2VkQml0bWFwRGF0YSA9IGZvcm1hdE5vcm1hbGlzZXIoXG4gICAgYml0bWFwRGF0YSxcbiAgICBtZXRhRGF0YSxcbiAgICBvcHRpb25zLnNraXBSZXNjYWxlXG4gICk7XG5cbiAgbWV0YURhdGEuZGF0YSA9IG5vcm1hbGlzZWRCaXRtYXBEYXRhO1xuICBtZXRhRGF0YS5nYW1tYSA9IGdhbW1hIHx8IDA7XG5cbiAgcmV0dXJuIG1ldGFEYXRhO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IGhhc1N5bmNabGliID0gdHJ1ZTtcbmxldCB6bGliID0gcmVxdWlyZShcInpsaWJcIik7XG5pZiAoIXpsaWIuZGVmbGF0ZVN5bmMpIHtcbiAgaGFzU3luY1psaWIgPSBmYWxzZTtcbn1cbmxldCBjb25zdGFudHMgPSByZXF1aXJlKFwiLi9jb25zdGFudHNcIik7XG5sZXQgUGFja2VyID0gcmVxdWlyZShcIi4vcGFja2VyXCIpO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uIChtZXRhRGF0YSwgb3B0KSB7XG4gIGlmICghaGFzU3luY1psaWIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBcIlRvIHVzZSB0aGUgc3luYyBjYXBhYmlsaXR5IG9mIHRoaXMgbGlicmFyeSBpbiBvbGQgbm9kZSB2ZXJzaW9ucywgcGxlYXNlIHBpbiBwbmdqcyB0byB2Mi4zLjBcIlxuICAgICk7XG4gIH1cblxuICBsZXQgb3B0aW9ucyA9IG9wdCB8fCB7fTtcblxuICBsZXQgcGFja2VyID0gbmV3IFBhY2tlcihvcHRpb25zKTtcblxuICBsZXQgY2h1bmtzID0gW107XG5cbiAgLy8gU2lnbmF0dXJlXG4gIGNodW5rcy5wdXNoKEJ1ZmZlci5mcm9tKGNvbnN0YW50cy5QTkdfU0lHTkFUVVJFKSk7XG5cbiAgLy8gSGVhZGVyXG4gIGNodW5rcy5wdXNoKHBhY2tlci5wYWNrSUhEUihtZXRhRGF0YS53aWR0aCwgbWV0YURhdGEuaGVpZ2h0KSk7XG5cbiAgaWYgKG1ldGFEYXRhLmdhbW1hKSB7XG4gICAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tHQU1BKG1ldGFEYXRhLmdhbW1hKSk7XG4gIH1cblxuICBsZXQgZmlsdGVyZWREYXRhID0gcGFja2VyLmZpbHRlckRhdGEoXG4gICAgbWV0YURhdGEuZGF0YSxcbiAgICBtZXRhRGF0YS53aWR0aCxcbiAgICBtZXRhRGF0YS5oZWlnaHRcbiAgKTtcblxuICAvLyBjb21wcmVzcyBpdFxuICBsZXQgY29tcHJlc3NlZERhdGEgPSB6bGliLmRlZmxhdGVTeW5jKFxuICAgIGZpbHRlcmVkRGF0YSxcbiAgICBwYWNrZXIuZ2V0RGVmbGF0ZU9wdGlvbnMoKVxuICApO1xuICBmaWx0ZXJlZERhdGEgPSBudWxsO1xuXG4gIGlmICghY29tcHJlc3NlZERhdGEgfHwgIWNvbXByZXNzZWREYXRhLmxlbmd0aCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJhZCBwbmcgLSBpbnZhbGlkIGNvbXByZXNzZWQgZGF0YSByZXNwb25zZVwiKTtcbiAgfVxuICBjaHVua3MucHVzaChwYWNrZXIucGFja0lEQVQoY29tcHJlc3NlZERhdGEpKTtcblxuICAvLyBFbmRcbiAgY2h1bmtzLnB1c2gocGFja2VyLnBhY2tJRU5EKCkpO1xuXG4gIHJldHVybiBCdWZmZXIuY29uY2F0KGNodW5rcyk7XG59O1xuIiwgIlwidXNlIHN0cmljdFwiO1xuXG5sZXQgcGFyc2UgPSByZXF1aXJlKFwiLi9wYXJzZXItc3luY1wiKTtcbmxldCBwYWNrID0gcmVxdWlyZShcIi4vcGFja2VyLXN5bmNcIik7XG5cbmV4cG9ydHMucmVhZCA9IGZ1bmN0aW9uIChidWZmZXIsIG9wdGlvbnMpIHtcbiAgcmV0dXJuIHBhcnNlKGJ1ZmZlciwgb3B0aW9ucyB8fCB7fSk7XG59O1xuXG5leHBvcnRzLndyaXRlID0gZnVuY3Rpb24gKHBuZywgb3B0aW9ucykge1xuICByZXR1cm4gcGFjayhwbmcsIG9wdGlvbnMpO1xufTtcbiIsICJcInVzZSBzdHJpY3RcIjtcblxubGV0IHV0aWwgPSByZXF1aXJlKFwidXRpbFwiKTtcbmxldCBTdHJlYW0gPSByZXF1aXJlKFwic3RyZWFtXCIpO1xubGV0IFBhcnNlciA9IHJlcXVpcmUoXCIuL3BhcnNlci1hc3luY1wiKTtcbmxldCBQYWNrZXIgPSByZXF1aXJlKFwiLi9wYWNrZXItYXN5bmNcIik7XG5sZXQgUE5HU3luYyA9IHJlcXVpcmUoXCIuL3BuZy1zeW5jXCIpO1xuXG5sZXQgUE5HID0gKGV4cG9ydHMuUE5HID0gZnVuY3Rpb24gKG9wdGlvbnMpIHtcbiAgU3RyZWFtLmNhbGwodGhpcyk7XG5cbiAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307IC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbm8tcGFyYW0tcmVhc3NpZ25cblxuICAvLyBjb2VyY2UgcGl4ZWwgZGltZW5zaW9ucyB0byBpbnRlZ2VycyAoYWxzbyBjb2VyY2VzIHVuZGVmaW5lZCAtPiAwKTpcbiAgdGhpcy53aWR0aCA9IG9wdGlvbnMud2lkdGggfCAwO1xuICB0aGlzLmhlaWdodCA9IG9wdGlvbnMuaGVpZ2h0IHwgMDtcblxuICB0aGlzLmRhdGEgPVxuICAgIHRoaXMud2lkdGggPiAwICYmIHRoaXMuaGVpZ2h0ID4gMFxuICAgICAgPyBCdWZmZXIuYWxsb2MoNCAqIHRoaXMud2lkdGggKiB0aGlzLmhlaWdodClcbiAgICAgIDogbnVsbDtcblxuICBpZiAob3B0aW9ucy5maWxsICYmIHRoaXMuZGF0YSkge1xuICAgIHRoaXMuZGF0YS5maWxsKDApO1xuICB9XG5cbiAgdGhpcy5nYW1tYSA9IDA7XG4gIHRoaXMucmVhZGFibGUgPSB0aGlzLndyaXRhYmxlID0gdHJ1ZTtcblxuICB0aGlzLl9wYXJzZXIgPSBuZXcgUGFyc2VyKG9wdGlvbnMpO1xuXG4gIHRoaXMuX3BhcnNlci5vbihcImVycm9yXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZXJyb3JcIikpO1xuICB0aGlzLl9wYXJzZXIub24oXCJjbG9zZVwiLCB0aGlzLl9oYW5kbGVDbG9zZS5iaW5kKHRoaXMpKTtcbiAgdGhpcy5fcGFyc2VyLm9uKFwibWV0YWRhdGFcIiwgdGhpcy5fbWV0YWRhdGEuYmluZCh0aGlzKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcImdhbW1hXCIsIHRoaXMuX2dhbW1hLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYXJzZXIub24oXG4gICAgXCJwYXJzZWRcIixcbiAgICBmdW5jdGlvbiAoZGF0YSkge1xuICAgICAgdGhpcy5kYXRhID0gZGF0YTtcbiAgICAgIHRoaXMuZW1pdChcInBhcnNlZFwiLCBkYXRhKTtcbiAgICB9LmJpbmQodGhpcylcbiAgKTtcblxuICB0aGlzLl9wYWNrZXIgPSBuZXcgUGFja2VyKG9wdGlvbnMpO1xuICB0aGlzLl9wYWNrZXIub24oXCJkYXRhXCIsIHRoaXMuZW1pdC5iaW5kKHRoaXMsIFwiZGF0YVwiKSk7XG4gIHRoaXMuX3BhY2tlci5vbihcImVuZFwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVuZFwiKSk7XG4gIHRoaXMuX3BhcnNlci5vbihcImNsb3NlXCIsIHRoaXMuX2hhbmRsZUNsb3NlLmJpbmQodGhpcykpO1xuICB0aGlzLl9wYWNrZXIub24oXCJlcnJvclwiLCB0aGlzLmVtaXQuYmluZCh0aGlzLCBcImVycm9yXCIpKTtcbn0pO1xudXRpbC5pbmhlcml0cyhQTkcsIFN0cmVhbSk7XG5cblBORy5zeW5jID0gUE5HU3luYztcblxuUE5HLnByb3RvdHlwZS5wYWNrID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuZGF0YSB8fCAhdGhpcy5kYXRhLmxlbmd0aCkge1xuICAgIHRoaXMuZW1pdChcImVycm9yXCIsIFwiTm8gZGF0YSBwcm92aWRlZFwiKTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIHByb2Nlc3MubmV4dFRpY2soXG4gICAgZnVuY3Rpb24gKCkge1xuICAgICAgdGhpcy5fcGFja2VyLnBhY2sodGhpcy5kYXRhLCB0aGlzLndpZHRoLCB0aGlzLmhlaWdodCwgdGhpcy5nYW1tYSk7XG4gICAgfS5iaW5kKHRoaXMpXG4gICk7XG5cbiAgcmV0dXJuIHRoaXM7XG59O1xuXG5QTkcucHJvdG90eXBlLnBhcnNlID0gZnVuY3Rpb24gKGRhdGEsIGNhbGxiYWNrKSB7XG4gIGlmIChjYWxsYmFjaykge1xuICAgIGxldCBvblBhcnNlZCwgb25FcnJvcjtcblxuICAgIG9uUGFyc2VkID0gZnVuY3Rpb24gKHBhcnNlZERhdGEpIHtcbiAgICAgIHRoaXMucmVtb3ZlTGlzdGVuZXIoXCJlcnJvclwiLCBvbkVycm9yKTtcblxuICAgICAgdGhpcy5kYXRhID0gcGFyc2VkRGF0YTtcbiAgICAgIGNhbGxiYWNrKG51bGwsIHRoaXMpO1xuICAgIH0uYmluZCh0aGlzKTtcblxuICAgIG9uRXJyb3IgPSBmdW5jdGlvbiAoZXJyKSB7XG4gICAgICB0aGlzLnJlbW92ZUxpc3RlbmVyKFwicGFyc2VkXCIsIG9uUGFyc2VkKTtcblxuICAgICAgY2FsbGJhY2soZXJyLCBudWxsKTtcbiAgICB9LmJpbmQodGhpcyk7XG5cbiAgICB0aGlzLm9uY2UoXCJwYXJzZWRcIiwgb25QYXJzZWQpO1xuICAgIHRoaXMub25jZShcImVycm9yXCIsIG9uRXJyb3IpO1xuICB9XG5cbiAgdGhpcy5lbmQoZGF0YSk7XG4gIHJldHVybiB0aGlzO1xufTtcblxuUE5HLnByb3RvdHlwZS53cml0ZSA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX3BhcnNlci53cml0ZShkYXRhKTtcbiAgcmV0dXJuIHRydWU7XG59O1xuXG5QTkcucHJvdG90eXBlLmVuZCA9IGZ1bmN0aW9uIChkYXRhKSB7XG4gIHRoaXMuX3BhcnNlci5lbmQoZGF0YSk7XG59O1xuXG5QTkcucHJvdG90eXBlLl9tZXRhZGF0YSA9IGZ1bmN0aW9uIChtZXRhZGF0YSkge1xuICB0aGlzLndpZHRoID0gbWV0YWRhdGEud2lkdGg7XG4gIHRoaXMuaGVpZ2h0ID0gbWV0YWRhdGEuaGVpZ2h0O1xuXG4gIHRoaXMuZW1pdChcIm1ldGFkYXRhXCIsIG1ldGFkYXRhKTtcbn07XG5cblBORy5wcm90b3R5cGUuX2dhbW1hID0gZnVuY3Rpb24gKGdhbW1hKSB7XG4gIHRoaXMuZ2FtbWEgPSBnYW1tYTtcbn07XG5cblBORy5wcm90b3R5cGUuX2hhbmRsZUNsb3NlID0gZnVuY3Rpb24gKCkge1xuICBpZiAoIXRoaXMuX3BhcnNlci53cml0YWJsZSAmJiAhdGhpcy5fcGFja2VyLnJlYWRhYmxlKSB7XG4gICAgdGhpcy5lbWl0KFwiY2xvc2VcIik7XG4gIH1cbn07XG5cblBORy5iaXRibHQgPSBmdW5jdGlvbiAoc3JjLCBkc3QsIHNyY1gsIHNyY1ksIHdpZHRoLCBoZWlnaHQsIGRlbHRhWCwgZGVsdGFZKSB7XG4gIC8vIGVzbGludC1kaXNhYmxlLWxpbmUgbWF4LXBhcmFtc1xuICAvLyBjb2VyY2UgcGl4ZWwgZGltZW5zaW9ucyB0byBpbnRlZ2VycyAoYWxzbyBjb2VyY2VzIHVuZGVmaW5lZCAtPiAwKTpcbiAgLyogZXNsaW50LWRpc2FibGUgbm8tcGFyYW0tcmVhc3NpZ24gKi9cbiAgc3JjWCB8PSAwO1xuICBzcmNZIHw9IDA7XG4gIHdpZHRoIHw9IDA7XG4gIGhlaWdodCB8PSAwO1xuICBkZWx0YVggfD0gMDtcbiAgZGVsdGFZIHw9IDA7XG4gIC8qIGVzbGludC1lbmFibGUgbm8tcGFyYW0tcmVhc3NpZ24gKi9cblxuICBpZiAoXG4gICAgc3JjWCA+IHNyYy53aWR0aCB8fFxuICAgIHNyY1kgPiBzcmMuaGVpZ2h0IHx8XG4gICAgc3JjWCArIHdpZHRoID4gc3JjLndpZHRoIHx8XG4gICAgc3JjWSArIGhlaWdodCA+IHNyYy5oZWlnaHRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiYml0Ymx0IHJlYWRpbmcgb3V0c2lkZSBpbWFnZVwiKTtcbiAgfVxuXG4gIGlmIChcbiAgICBkZWx0YVggPiBkc3Qud2lkdGggfHxcbiAgICBkZWx0YVkgPiBkc3QuaGVpZ2h0IHx8XG4gICAgZGVsdGFYICsgd2lkdGggPiBkc3Qud2lkdGggfHxcbiAgICBkZWx0YVkgKyBoZWlnaHQgPiBkc3QuaGVpZ2h0XG4gICkge1xuICAgIHRocm93IG5ldyBFcnJvcihcImJpdGJsdCB3cml0aW5nIG91dHNpZGUgaW1hZ2VcIik7XG4gIH1cblxuICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSB7XG4gICAgc3JjLmRhdGEuY29weShcbiAgICAgIGRzdC5kYXRhLFxuICAgICAgKChkZWx0YVkgKyB5KSAqIGRzdC53aWR0aCArIGRlbHRhWCkgPDwgMixcbiAgICAgICgoc3JjWSArIHkpICogc3JjLndpZHRoICsgc3JjWCkgPDwgMixcbiAgICAgICgoc3JjWSArIHkpICogc3JjLndpZHRoICsgc3JjWCArIHdpZHRoKSA8PCAyXG4gICAgKTtcbiAgfVxufTtcblxuUE5HLnByb3RvdHlwZS5iaXRibHQgPSBmdW5jdGlvbiAoXG4gIGRzdCxcbiAgc3JjWCxcbiAgc3JjWSxcbiAgd2lkdGgsXG4gIGhlaWdodCxcbiAgZGVsdGFYLFxuICBkZWx0YVlcbikge1xuICAvLyBlc2xpbnQtZGlzYWJsZS1saW5lIG1heC1wYXJhbXNcblxuICBQTkcuYml0Ymx0KHRoaXMsIGRzdCwgc3JjWCwgc3JjWSwgd2lkdGgsIGhlaWdodCwgZGVsdGFYLCBkZWx0YVkpO1xuICByZXR1cm4gdGhpcztcbn07XG5cblBORy5hZGp1c3RHYW1tYSA9IGZ1bmN0aW9uIChzcmMpIHtcbiAgaWYgKHNyYy5nYW1tYSkge1xuICAgIGZvciAobGV0IHkgPSAwOyB5IDwgc3JjLmhlaWdodDsgeSsrKSB7XG4gICAgICBmb3IgKGxldCB4ID0gMDsgeCA8IHNyYy53aWR0aDsgeCsrKSB7XG4gICAgICAgIGxldCBpZHggPSAoc3JjLndpZHRoICogeSArIHgpIDw8IDI7XG5cbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCAzOyBpKyspIHtcbiAgICAgICAgICBsZXQgc2FtcGxlID0gc3JjLmRhdGFbaWR4ICsgaV0gLyAyNTU7XG4gICAgICAgICAgc2FtcGxlID0gTWF0aC5wb3coc2FtcGxlLCAxIC8gMi4yIC8gc3JjLmdhbW1hKTtcbiAgICAgICAgICBzcmMuZGF0YVtpZHggKyBpXSA9IE1hdGgucm91bmQoc2FtcGxlICogMjU1KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBzcmMuZ2FtbWEgPSAwO1xuICB9XG59O1xuXG5QTkcucHJvdG90eXBlLmFkanVzdEdhbW1hID0gZnVuY3Rpb24gKCkge1xuICBQTkcuYWRqdXN0R2FtbWEodGhpcyk7XG59O1xuIiwgImltcG9ydCB7IFBORyB9IGZyb20gJ3BuZ2pzJztcbmltcG9ydCB0eXBlIHsgU3ByaXRlQXNzZXRTcGVjIH0gZnJvbSAnLi4vdHlwZXMnO1xuXG5jb25zdCBTSUdOQVRVUkUgPSBCdWZmZXIuZnJvbShbMTM3LCA4MCwgNzgsIDcxLCAxMywgMTAsIDI2LCAxMF0pO1xuY29uc3QgTUFYX1BJWEVMUyA9IDE2ICogMTAyNCAqIDEwMjQ7XG5jb25zdCBNQVhfQllURVMgPSA2NCAqIDEwMjQgKiAxMDI0O1xuY29uc3QgQ09MT1JfQ0hVTktTID0gbmV3IFNldChbJ2dBTUEnLCAnY0hSTScsICdzUkdCJywgJ2lDQ1AnLCAncEhZcyddKTtcblxuZXhwb3J0IGludGVyZmFjZSBUaWxlZFJhc3RlciB7XG4gICAgY29udGVudHM6IEJ1ZmZlcjtcbiAgICBzb3VyY2VXaWR0aDogbnVtYmVyO1xuICAgIHNvdXJjZUhlaWdodDogbnVtYmVyO1xuICAgIHdpZHRoOiBudW1iZXI7XG4gICAgaGVpZ2h0OiBudW1iZXI7XG4gICAgcm91bmRlZDogYm9vbGVhbjtcbn1cblxuLyoqIFNlcGFyYXRlIG91dHB1dCBpZGVudGl0eSBmcm9tIHRoZSB1bmNoYW5nZWQsIG9yaWdpbmFsLWltYWdlIGRvd25sb2FkIGNhY2hlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpbGVkUmFzdGVyS2V5KHNvdXJjZUtleTogc3RyaW5nLCByZXF1ZXN0ZWRTY2FsZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgICBwb3NpdGl2ZVNjYWxlKHJlcXVlc3RlZFNjYWxlKTtcbiAgICByZXR1cm4gSlNPTi5zdHJpbmdpZnkoeyBzb3VyY2VLZXksIHNpemluZzogJ2ZpZ21hLXZpc2libGUtcGl4ZWxzLXYxJywgcmVxdWVzdGVkU2NhbGUgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBwaXhlbFNpemVkVGlsZUFzc2V0KGFzc2V0OiBTcHJpdGVBc3NldFNwZWMpOiBTcHJpdGVBc3NldFNwZWMge1xuICAgIHJldHVybiB7IC4uLmFzc2V0LCB0aWxlZDogdHJ1ZSwgc2xpY2VkOiBmYWxzZSwgdGlsZVNjYWxlOiAxIH07XG59XG5cbmZ1bmN0aW9uIHBvc2l0aXZlU2NhbGUodmFsdWU6IG51bWJlcik6IHZvaWQge1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB0aHJvdyBuZXcgRXJyb3IoJ1x1NUU3M1x1OTRGQVx1OEQ0NFx1NkU5MFx1NTAwRFx1NzM4N1x1NUZDNVx1OTg3Qlx1NEUzQVx1NkI2M1x1NjU3MFx1MzAwMicpO1xufVxuXG5mdW5jdGlvbiBkaW1lbnNpb25zKHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKCFOdW1iZXIuaXNTYWZlSW50ZWdlcih3aWR0aCkgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKGhlaWdodCkgfHwgd2lkdGggPCAxIHx8IGhlaWdodCA8IDFcbiAgICAgICAgfHwgd2lkdGggPiA4MTkyIHx8IGhlaWdodCA+IDgxOTIgfHwgd2lkdGggKiBoZWlnaHQgPiBNQVhfUElYRUxTKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcignXHU1RTczXHU5NEZBXHU4RDQ0XHU2RTkwXHU1QzNBXHU1QkY4XHU4RDg1XHU4RkM3XHU1Qjg5XHU1MTY4XHU1OTA0XHU3NDA2XHU4MzAzXHU1NkY0XHVGRjA4XHU1MzU1XHU4RkI5IDgxOTJcdUZGMENcdTU0MDhcdThCQTEgMTYwMCBcdTRFMDdcdTUwQ0ZcdTdEMjBcdUZGMDlcdTMwMDInKTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIGluc3BlY3QoY29udGVudHM6IEJ1ZmZlcik6IHsgd2lkdGg6IG51bWJlcjsgaGVpZ2h0OiBudW1iZXI7IG1ldGFkYXRhOiBCdWZmZXJbXSB9IHtcbiAgICBpZiAoY29udGVudHMubGVuZ3RoIDwgNDUgfHwgY29udGVudHMubGVuZ3RoID4gTUFYX0JZVEVTIHx8ICFjb250ZW50cy5zdWJhcnJheSgwLCA4KS5lcXVhbHMoU0lHTkFUVVJFKVxuICAgICAgICB8fCBjb250ZW50cy5yZWFkVUludDMyQkUoOCkgIT09IDEzIHx8IGNvbnRlbnRzLnRvU3RyaW5nKCdhc2NpaScsIDEyLCAxNikgIT09ICdJSERSJykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1x1NUU3M1x1OTRGQVx1NTZGRVx1NzI0N1x1NEUwRFx1NjYyRlx1NjcwOVx1NjU0OFx1NzY4NCBQTkdcdTMwMDInKTtcbiAgICB9XG4gICAgY29uc3Qgd2lkdGggPSBjb250ZW50cy5yZWFkVUludDMyQkUoMTYpLCBoZWlnaHQgPSBjb250ZW50cy5yZWFkVUludDMyQkUoMjApO1xuICAgIGRpbWVuc2lvbnMod2lkdGgsIGhlaWdodCk7XG4gICAgaWYgKGNvbnRlbnRzWzI0XSA+IDgpIHRocm93IG5ldyBFcnJvcignXHU2NjgyXHU0RTBEXHU2NTJGXHU2MzAxXHU5MUNEXHU5MUM3XHU2ODM3XHU5QUQ4XHU0RjREXHU2REYxXHU1RTczXHU5NEZBXHU1NkZFXHU3MjQ3XHUzMDAyJyk7XG4gICAgY29uc3QgbWV0YWRhdGE6IEJ1ZmZlcltdID0gW107XG4gICAgZm9yIChsZXQgb2Zmc2V0ID0gODsgb2Zmc2V0ICsgMTIgPD0gY29udGVudHMubGVuZ3RoOykge1xuICAgICAgICBjb25zdCBlbmQgPSBvZmZzZXQgKyAxMiArIGNvbnRlbnRzLnJlYWRVSW50MzJCRShvZmZzZXQpO1xuICAgICAgICBpZiAoZW5kID4gY29udGVudHMubGVuZ3RoKSBicmVhaztcbiAgICAgICAgY29uc3QgdHlwZSA9IGNvbnRlbnRzLnRvU3RyaW5nKCdhc2NpaScsIG9mZnNldCArIDQsIG9mZnNldCArIDgpO1xuICAgICAgICBpZiAoWydhY1RMJywgJ2ZjVEwnLCAnZmRBVCcsICdzQklUJ10uaW5jbHVkZXModHlwZSkpIHRocm93IG5ldyBFcnJvcignXHU2NjgyXHU0RTBEXHU2NTJGXHU2MzAxXHU5MUNEXHU5MUM3XHU2ODM3XHU1MkE4XHU3NTNCXHU2MjE2XHU3Mjc5XHU2QjhBXHU0RjREXHU2REYxXHU1RTczXHU5NEZBXHU1NkZFXHU3MjQ3XHUzMDAyJyk7XG4gICAgICAgIGlmIChDT0xPUl9DSFVOS1MuaGFzKHR5cGUpKSBtZXRhZGF0YS5wdXNoKGNvbnRlbnRzLnN1YmFycmF5KG9mZnNldCwgZW5kKSk7XG4gICAgICAgIGlmICh0eXBlID09PSAnSUVORCcpIHJldHVybiB7IHdpZHRoLCBoZWlnaHQsIG1ldGFkYXRhIH07XG4gICAgICAgIG9mZnNldCA9IGVuZDtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKCdcdTVFNzNcdTk0RkEgUE5HIFx1NjU3MFx1NjM2RVx1NEUwRFx1NUI4Q1x1NjU3NFx1MzAwMicpO1xufVxuXG4vKiogQ3JlYXRvciBzdXBwbGllcyBFbGVjdHJvbiBmb3IgSlBFRy9XZWJQL0JNUC9zdGF0aWMgR0lGIGRlY29kaW5nLiAqL1xuZnVuY3Rpb24gZGVjb2RlVG9QbmcoY29udGVudHM6IEJ1ZmZlcik6IEJ1ZmZlciB7XG4gICAgY29uc3QgeyBuYXRpdmVJbWFnZSB9ID0gcmVxdWlyZSgnZWxlY3Ryb24nKTtcbiAgICBjb25zdCBpbWFnZSA9IG5hdGl2ZUltYWdlLmNyZWF0ZUZyb21CdWZmZXIoY29udGVudHMpO1xuICAgIGlmIChpbWFnZS5pc0VtcHR5KCkpIHRocm93IG5ldyBFcnJvcignXHU2NUUwXHU2Q0Q1XHU4OUUzXHU3ODAxXHU1RTczXHU5NEZBXHU2RTkwXHU1NkZFXHU3MjQ3XHUzMDAyJyk7XG4gICAgY29uc3QgeyB3aWR0aCwgaGVpZ2h0IH0gPSBpbWFnZS5nZXRTaXplKCk7XG4gICAgZGltZW5zaW9ucyh3aWR0aCwgaGVpZ2h0KTtcbiAgICByZXR1cm4gaW1hZ2UudG9QTkcoKTtcbn1cblxudHlwZSBTYW1wbGUgPSB7IGluZGV4OiBudW1iZXI7IHdlaWdodDogbnVtYmVyIH07XG5mdW5jdGlvbiBzYW1wbGVzKHNvdXJjZTogbnVtYmVyLCB0YXJnZXQ6IG51bWJlcik6IFNhbXBsZVtdW10ge1xuICAgIGNvbnN0IHJhdGlvID0gc291cmNlIC8gdGFyZ2V0O1xuICAgIHJldHVybiBBcnJheS5mcm9tKHsgbGVuZ3RoOiB0YXJnZXQgfSwgKF8sIG91dCkgPT4ge1xuICAgICAgICBpZiAocmF0aW8gPj0gMSkge1xuICAgICAgICAgICAgLy8gQXJlYSBhdmVyYWdpbmcgYXZvaWRzIGFsaWFzaW5nIHdoZW4gcmVkdWNpbmcgdGhlIHJlcGVhdGVkIHRleHR1cmUuXG4gICAgICAgICAgICBjb25zdCBzdGFydCA9IG91dCAqIHJhdGlvLCBlbmQgPSAob3V0ICsgMSkgKiByYXRpbztcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdDogU2FtcGxlW10gPSBbXTtcbiAgICAgICAgICAgIGZvciAobGV0IGkgPSBNYXRoLmZsb29yKHN0YXJ0KTsgaSA8IE1hdGguY2VpbChlbmQpOyBpKyspIHtcbiAgICAgICAgICAgICAgICBjb25zdCB3ZWlnaHQgPSAoTWF0aC5taW4oZW5kLCBpICsgMSkgLSBNYXRoLm1heChzdGFydCwgaSkpIC8gcmF0aW87XG4gICAgICAgICAgICAgICAgaWYgKHdlaWdodCA+IDApIHJlc3VsdC5wdXNoKHsgaW5kZXg6IE1hdGgubWluKHNvdXJjZSAtIDEsIGkpLCB3ZWlnaHQgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9XG4gICAgICAgIC8vIFVwc2FtcGxpbmcgdXNlcyBwZXJpb2RpYyBlZGdlcywgbm90IGNsYW1waW5nOiB0aGlzIGltYWdlIGlzIGEgdGlsZS5cbiAgICAgICAgY29uc3QgY2VudGVyID0gKG91dCArIDAuNSkgKiByYXRpbyAtIDAuNTtcbiAgICAgICAgY29uc3QgbGVmdCA9IE1hdGguZmxvb3IoY2VudGVyKSwgZnJhY3Rpb24gPSBjZW50ZXIgLSBsZWZ0O1xuICAgICAgICByZXR1cm4gW3sgaW5kZXg6IChsZWZ0ICsgc291cmNlKSAlIHNvdXJjZSwgd2VpZ2h0OiAxIC0gZnJhY3Rpb24gfSxcbiAgICAgICAgICAgIHsgaW5kZXg6IChsZWZ0ICsgMSkgJSBzb3VyY2UsIHdlaWdodDogZnJhY3Rpb24gfV07XG4gICAgfSk7XG59XG5cbi8qKiBCYWtlIGRpc3BsYXkgc2l6ZSBpbnRvIFBORyBwaXhlbHMsIG5ldmVyIGludG8gdGhlIFNjZW5lIG5vZGUncyBTY2FsZS5cbiAqIFNvdXJjZS1ub2RlIGV4cG9ydHMgbWF5IGFscmVhZHkgaW5jbHVkZSBhIHJlbmRlciBzY2FsZTsgdW5kbyB0aGF0IGZhY3RvciBvbmNlLlxuICogRnJhY3Rpb25hbCBkaW1lbnNpb25zIHJvdW5kIHRvIG5lYXJlc3Qgd2hvbGUgcGl4ZWwgKG1pbmltdW0gb25lKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJhc3Rlcml6ZVRpbGUoY29udGVudHM6IEJ1ZmZlciwgcmVxdWVzdGVkU2NhbGU6IG51bWJlciwgc291cmNlUmVuZGVyU2NhbGUgPSAxLFxuICAgIGRlY29kZTogKGRhdGE6IEJ1ZmZlcikgPT4gQnVmZmVyID0gZGVjb2RlVG9QbmcpOiBUaWxlZFJhc3RlciB7XG4gICAgcG9zaXRpdmVTY2FsZShyZXF1ZXN0ZWRTY2FsZSk7XG4gICAgcG9zaXRpdmVTY2FsZShzb3VyY2VSZW5kZXJTY2FsZSk7XG4gICAgaWYgKCFjb250ZW50cy5sZW5ndGggfHwgY29udGVudHMubGVuZ3RoID4gTUFYX0JZVEVTKSB0aHJvdyBuZXcgRXJyb3IoJ1x1NUU3M1x1OTRGQVx1NkU5MFx1NTZGRVx1NzI0N1x1NEUzQVx1N0E3QVx1NjIxNlx1OEQ4NVx1OEZDNyA2NCBNQlx1MzAwMicpO1xuICAgIGNvbnN0IHBuZyA9IGNvbnRlbnRzLnN1YmFycmF5KDAsIDgpLmVxdWFscyhTSUdOQVRVUkUpID8gY29udGVudHMgOiBkZWNvZGUoY29udGVudHMpO1xuICAgIGNvbnN0IGhlYWRlciA9IGluc3BlY3QocG5nKTtcbiAgICBjb25zdCBkZXNpcmVkV2lkdGggPSBoZWFkZXIud2lkdGggKiByZXF1ZXN0ZWRTY2FsZSAvIHNvdXJjZVJlbmRlclNjYWxlO1xuICAgIGNvbnN0IGRlc2lyZWRIZWlnaHQgPSBoZWFkZXIuaGVpZ2h0ICogcmVxdWVzdGVkU2NhbGUgLyBzb3VyY2VSZW5kZXJTY2FsZTtcbiAgICBjb25zdCB3aWR0aCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoZGVzaXJlZFdpZHRoKSksIGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoZGVzaXJlZEhlaWdodCkpO1xuICAgIGRpbWVuc2lvbnMod2lkdGgsIGhlaWdodCk7XG4gICAgY29uc3QgaW5mbyA9IHsgc291cmNlV2lkdGg6IGhlYWRlci53aWR0aCwgc291cmNlSGVpZ2h0OiBoZWFkZXIuaGVpZ2h0LCB3aWR0aCwgaGVpZ2h0LFxuICAgICAgICByb3VuZGVkOiBNYXRoLmFicyh3aWR0aCAtIGRlc2lyZWRXaWR0aCkgPiAxZS02IHx8IE1hdGguYWJzKGhlaWdodCAtIGRlc2lyZWRIZWlnaHQpID4gMWUtNiB9O1xuICAgIGNvbnN0IGlucHV0ID0gUE5HLnN5bmMucmVhZChwbmcsIHsgY2hlY2tDUkM6IHRydWUgfSk7XG4gICAgaWYgKHdpZHRoID09PSBoZWFkZXIud2lkdGggJiYgaGVpZ2h0ID09PSBoZWFkZXIuaGVpZ2h0KSByZXR1cm4geyAuLi5pbmZvLCBjb250ZW50czogcG5nIH07XG4gICAgY29uc3Qgb3V0cHV0ID0gbmV3IFBORyh7IHdpZHRoLCBoZWlnaHQgfSk7XG4gICAgY29uc3QgeHMgPSBzYW1wbGVzKGhlYWRlci53aWR0aCwgd2lkdGgpLCB5cyA9IHNhbXBsZXMoaGVhZGVyLmhlaWdodCwgaGVpZ2h0KTtcbiAgICBmb3IgKGxldCB5ID0gMDsgeSA8IGhlaWdodDsgeSsrKSBmb3IgKGxldCB4ID0gMDsgeCA8IHdpZHRoOyB4KyspIHtcbiAgICAgICAgbGV0IGFscGhhID0gMCwgcmVkID0gMCwgZ3JlZW4gPSAwLCBibHVlID0gMDtcbiAgICAgICAgZm9yIChjb25zdCBzeSBvZiB5c1t5XSkgZm9yIChjb25zdCBzeCBvZiB4c1t4XSkge1xuICAgICAgICAgICAgY29uc3QgcG9zID0gKHN5LmluZGV4ICogaGVhZGVyLndpZHRoICsgc3guaW5kZXgpICogNDtcbiAgICAgICAgICAgIGNvbnN0IGEgPSBpbnB1dC5kYXRhW3BvcyArIDNdICogc3kud2VpZ2h0ICogc3gud2VpZ2h0O1xuICAgICAgICAgICAgYWxwaGEgKz0gYTtcbiAgICAgICAgICAgIHJlZCArPSBpbnB1dC5kYXRhW3Bvc10gKiBhOyBncmVlbiArPSBpbnB1dC5kYXRhW3BvcyArIDFdICogYTsgYmx1ZSArPSBpbnB1dC5kYXRhW3BvcyArIDJdICogYTtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBwb3MgPSAoeSAqIHdpZHRoICsgeCkgKiA0O1xuICAgICAgICAvLyBQcmVtdWx0aXBsaWVkLWFscGhhIHNhbXBsaW5nIHByZXZlbnRzIHRyYW5zcGFyZW50IFJHQiBmcm9tIGFkZGluZyBmcmluZ2VzLlxuICAgICAgICBvdXRwdXQuZGF0YVtwb3MgKyAzXSA9IE1hdGgucm91bmQoYWxwaGEpO1xuICAgICAgICBpZiAoYWxwaGEgPiAwKSB7XG4gICAgICAgICAgICBvdXRwdXQuZGF0YVtwb3NdID0gTWF0aC5yb3VuZChyZWQgLyBhbHBoYSk7XG4gICAgICAgICAgICBvdXRwdXQuZGF0YVtwb3MgKyAxXSA9IE1hdGgucm91bmQoZ3JlZW4gLyBhbHBoYSk7XG4gICAgICAgICAgICBvdXRwdXQuZGF0YVtwb3MgKyAyXSA9IE1hdGgucm91bmQoYmx1ZSAvIGFscGhhKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBjb25zdCBlbmNvZGVkID0gUE5HLnN5bmMud3JpdGUob3V0cHV0KTtcbiAgICByZXR1cm4geyAuLi5pbmZvLCBjb250ZW50czogaGVhZGVyLm1ldGFkYXRhLmxlbmd0aFxuICAgICAgICA/IEJ1ZmZlci5jb25jYXQoW2VuY29kZWQuc3ViYXJyYXkoMCwgMzMpLCAuLi5oZWFkZXIubWV0YWRhdGEsIGVuY29kZWQuc3ViYXJyYXkoMzMpXSkgOiBlbmNvZGVkIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQTtBQUFBLDBDQUFBQSxVQUFBQyxTQUFBO0FBQUE7QUFFQSxRQUFJLE9BQU8sUUFBUSxNQUFNO0FBQ3pCLFFBQUksU0FBUyxRQUFRLFFBQVE7QUFFN0IsUUFBSSxjQUFlQSxRQUFPLFVBQVUsV0FBWTtBQUM5QyxhQUFPLEtBQUssSUFBSTtBQUVoQixXQUFLLFdBQVcsQ0FBQztBQUNqQixXQUFLLFlBQVk7QUFFakIsV0FBSyxTQUFTLENBQUM7QUFDZixXQUFLLFVBQVU7QUFFZixXQUFLLFlBQVk7QUFDakIsV0FBSyxXQUFXO0FBQUEsSUFDbEI7QUFDQSxTQUFLLFNBQVMsYUFBYSxNQUFNO0FBRWpDLGdCQUFZLFVBQVUsT0FBTyxTQUFVLFFBQVEsVUFBVTtBQUN2RCxXQUFLLE9BQU8sS0FBSztBQUFBLFFBQ2YsUUFBUSxLQUFLLElBQUksTUFBTTtBQUFBO0FBQUEsUUFDdkIsV0FBVyxTQUFTO0FBQUEsUUFDcEIsTUFBTTtBQUFBLE1BQ1IsQ0FBQztBQUVELGNBQVE7QUFBQSxRQUNOLFdBQVk7QUFDVixlQUFLLFNBQVM7QUFHZCxjQUFJLEtBQUssV0FBVyxLQUFLLFVBQVUsS0FBSyxPQUFPLFNB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QU0sQ0FBQyxJQUFJLEtBQUssTUFBTSxRQUFRLEtBQUs7QUFDL0MsYUFBTyxLQUFLLE1BQU0sQ0FBQyxJQUFJLEtBQUssTUFBTSxPQUFPLEtBQUs7QUFBQSxJQUNsRDtBQUFBLEVBQ0o7QUFDQSxRQUFNLFVBQVUsaUJBQUksS0FBSyxNQUFNLE1BQU07QUFDckMsU0FBTyxFQUFFLEdBQUcsTUFBTSxVQUFVLE9BQU8sU0FBUyxTQUN0QyxPQUFPLE9BQU8sQ0FBQyxRQUFRLFNBQVMsR0FBRyxFQUFFLEdBQUcsR0FBRyxPQUFPLFVBQVUsUUFBUSxTQUFTLEVBQUUsQ0FBQyxDQUFDLElBQUksUUFBUTtBQUN2RzsiLAogICJuYW1lcyI6IFsiZXhwb3J0cyIsICJtb2R1bGUiLCAiZXhwb3J0cyIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgIm1vZHVsZSIsICJleHBvcnRzIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZXhwb3J0cyIsICJtb2R1bGUiLCAiaW5mbGF0ZWREYXRhIiwgImV4cG9ydHMiLCAibW9kdWxlIiwgImV4cG9ydHMiLCAiZXhwb3J0cyIsICJQTkciLCAicG9zIl0KfQo=
