var glpVerboseLogs = false;

/**
 * Instantiates messaging with the devtools panel
 */
function glpInit() {
    window.postMessage({ type: "init" }, "*");
}
glpInit();

/**
 * Sends messages to the devtools panel
 * @param {String} Message type
 * @param {Dictionary} Message data
 */
function glpSendMessage(type, data) {
    window.postMessage({ source:"content", type: type, data: data}, "*");
}

/**
 * Receive messages from the devtools panel
 */
window.addEventListener('message', function(event) {
  var message = event.data;

  // Only accept messages that we know are ours
  if (typeof message !== 'object' || message === null || message.source != "panel") {
    return;
  }

  if (message.type == "pixelInspector") {
    glpPixelInspectorToggle(message.data.enabled);
  } else if (message.type == "callStackRequest") {
    glpSendCallStack(message.data);
  } else if (message.type == "functionHistogramRequest") {
    glpSendFunctionHistogram();
  } else {
    console.log(message.data);
  }
});

WebGLRenderingContext.prototype.glpCallstackEnabled = true;
WebGLRenderingContext.prototype.glpCallstackMaxSize = 100;
WebGLRenderingContext.prototype.glpFunctionHistogramEnabled = true;
WebGLRenderingContext.prototype.glpMostRecentCalls = [];
WebGLRenderingContext.prototype.glpCallsSinceDraw = [];
/*
 * Define all glp functions to be bound
*/
var glpFcnBindings = {
    // The default function is called first before all other method calls
    default: function(original, args, name) {
        if (glpVerboseLogs) {
            console.log("Function Call: " + name)
        }
        if (this.glpCallstackEnabled) {
            var callDetails = [name, JSON.stringify(args)];

            if (this.glpMostRecentCalls.length > this.glpCallstackMaxSize) {
                this.glpMostRecentCalls.shift();
            }
            this.glpMostRecentCalls.push(callDetails);

            if (name == "drawElements" || name == "drawArrays") {
                this.glpCallsSinceDraw = [];
            }
            this.glpCallsSinceDraw.push(callDetails);
        }
        if (this.glpFunctionHistogramEnabled) {
          if (!this.glpFunctionHistogram) {
            this.glpFunctionHistogram = {};
          }
          if (!this.glpFunctionHistogram[name]) {
            this.glpFunctionHistogram[name] = 1;
          } else {
            this.glpFunctionHistogram[name] += 1;
          }
        }
        return original.apply(this, args);
    },
    attachShader : function(original, args, name) {
        var program = args[0];
        var shader = args[1];
        var shaderType = this.getShaderParameter(shader, this.SHADER_TYPE);

        // TODO: verify valid input
        // glpPixelInspector: store vertex shaders associated with program
        if (shaderType == this.VERTEX_SHADER) {
          this.glpVertexShaders[program.__uuid] = shader;
        } else {
          this.glpFragmentShaders[program.__uuid] = shader;
        }

        return original.apply(this, args);
    },
    enable: function(original, args, name) {
        // glpPixelInspector: save BLEND and DEPTH_TEST state
        if (this.pixelInspectorEnabled) {
          if (args[0] == this.DEPTH_TEST) {
            this.glpPixelInspectorDepthTest = true;
            return;
          } else if (args[0] == this.BLEND) {
            this.glpPixelInspectorBlendProp = true;
            return;
          }
        }

        return original.apply(this, args);
    },
    disable: function(original, args, name) {
        // glpPixelInspector: save BLEND and DEPTH_TEST state
        if (this.pixelInspectorEnabled) {
          if (args[0] == this.DEPTH_TEST) {
            this.glpPixelInspectorDepthTest = false;
            return;
          } else if (args[0] == this.BLEND) {
            this.glpPixelInspectorBlendProp = false;
            return;
          }
        }

        return original.apply(this, args);
    },
    blendFunc: function(original, args, name) {
        // glpPixelInspector: save blendFunc state
        // TODO: verify valid input
        if (this.pixelInspectorEnabled) {
            this.glpPixelInspectorBlendFuncSFactor = args[0];
            this.glpPixelInspectorBlendFuncDFactor = args[1];
            return;
        }

        return original.apply(this, args);
    },
    clearColor: function(original, args, name) {
        // glpPixelInspector: save clear color state
        // TODO: verify valid input
        if (this.pixelInspectorEnabled) {
          this.glpPixelInspectorClearColor = args;
          return;
        }

        return original.apply(this, args);
    },
    useProgram: function(original, args, name) {
        // glpPixelInspector: replace the program with pixel inspector program
        // TODO: Handle case where program provided is the pixel inspector program
        // TODO: verify valid input
        var program = args[0];

        var retVal = original.apply(this, args);
        if (this.pixelInspectorEnabled && this.glpPixelInspectorPrograms.indexOf(program.__uuid) < 0) {
          this.glpSwitchToPixelInspectorProgram()
        }
        return retVal;
    },
    getUniform: function(original, args, name) {
      if (this.pixelInspectorEnabled) {
        var program = args[0];
        var location = args[1];
        if (this.glpPixelInspectorPrograms.indexOf(program.__uuid) >= 0) {
          if (location in this.glpPixelInspectorLocationMap[program.__uuid]) {
            // the program is the pixel inspector version and we're using the original location
            args[1] = this.glpPixelInspectorLocationMap[program.__uuid][location.__uuid];
          } else {
          }
        } else {
          // the program is not a pixel inspector
          // if they're using the wrong location, lets just swap programs
          args[0] = this.getParameter(this.CURRENT_PROGRAM);
        }
      }
      return original.apply(this, args);
    },
    createProgram: function(original, args, name) {
      var program = original.apply(this, args);
      program.__uuid = guid();
      return program;
    },
    getUniformLocation: function(original, args, name) {
      var program = args[0];
      var n = args[1];
      if (!(program.__uuid in this.glpProgramUniformLocations)) {
        this.glpProgramUniformLocations[program.__uuid] = {}
      }
      if (!(n in this.glpProgramUniformLocations[program.__uuid])) {
        var location = original.apply(this, args);
        if (!location) {
          return;
        }
        location.__uuid = guid();
        this.glpProgramUniformLocations[program.__uuid][n] = location;
        return location;
      }

      return this.glpProgramUniformLocations[program.__uuid][n];
    },
}

var glpUniformFcn = function(original, args, name) {
  if (this.pixelInspectorEnabled) {
    if (args[0] && this.glpPixelInspectorPrograms.indexOf(this.getParameter(this.CURRENT_PROGRAM).__uuid) >= 0) {
      args[0] = this.glpPixelInspectorLocationMap[this.getParameter(this.CURRENT_PROGRAM).__uuid][args[0].__uuid];
    }
  }
  return original.apply(this, args);
}
var uniformMethods = [
    'uniform1f', 'uniform1fv', 'uniform1i', 'uniform1iv',
    'uniform2f', 'uniform2fv', 'uniform2i', 'uniform2iv',
    'uniform3f', 'uniform3fv', 'uniform3i', 'uniform3iv',
    'uniform4f', 'uniform4fv', 'uniform4i', 'uniform4iv',
    'uniformMatrix2fv', 'uniformMatrix3fv', 'uniformMatrix4fv'
];
for (var i=0; i<uniformMethods.length; i++) {
    glpFcnBindings[uniformMethods[i]] = glpUniformFcn;
}

/**
 * Returns the WebGL contexts available in the dom
 * @param {Array} WebGL Contexts
 */
function glpGetWebGLContexts() {
  var canvases = document.getElementsByTagName("canvas");
  var contexts = [];
  for (var i = 0; i < canvases.length; i++) {
    var canvas = canvases[i];
    var webGLContext = canvas.getContext("webgl");
    if (webGLContext == null) {
      continue;
    }
    contexts.push(webGLContext);
  }
  return contexts;
}

/**
 * Sends call stack information to the panel
 * @param {String} Type of stack requested
 */
function glpSendCallStack(type) {
    // TODO: Handle multiple contexts
    var contexts = glpGetWebGLContexts();
    if (contexts == null || contexts[0] == null) {
        return;
    }

    var context = contexts[0];
    var callStack;
    if (type == "mostRecentCalls") {
        callStack = context.glpMostRecentCalls;
    } else {
        callStack = context.glpCallsSinceDraw;
    }

    glpSendMessage("CallStack", {"functionNames": callStack})
}

/**
 * Sends histogram of function calls to the panel
 */
function glpSendFunctionHistogram() {
    // TODO: Handle multiple contexts
    var contexts = glpGetWebGLContexts();
    if (contexts == null || contexts[0] == null) {
        return;
    }
    var context = contexts[0];
    glpSendMessage("FunctionHistogram", {"histogram": context.glpFunctionHistogram})
}

/**
 * Toggles the status of the pixel inspector being enabled/disabled
 * @param {Bool} Enabled
 */
function glpPixelInspectorToggle(enabled) {
  var contexts = glpGetWebGLContexts();
  if (contexts == null) {
    return;
  }

  for (var i = 0; i < contexts.length; i++) {
    var webGLContext = contexts[i];
    if (enabled) {
      webGLContext.glpEnablePixelInspector();
    } else {
      webGLContext.glpDisablePixelInspector();
    }
  }
}

WebGLRenderingContext.prototype.glpPixelInspectorBlendProp = null;
WebGLRenderingContext.prototype.glpPixelInspectorBlendFuncSFactor = null;
WebGLRenderingContext.prototype.glpPixelInspectorBlendFuncDFactor = null;
WebGLRenderingContext.prototype.glpPixelInspectorDepthTest = null;
WebGLRenderingContext.prototype.glpPixelInspectorClearColor = null;
WebGLRenderingContext.prototype.glpVertexShaders = {};
WebGLRenderingContext.prototype.glpFragmentShaders = {};
WebGLRenderingContext.prototype.glpPixelInspectorPrograms = [];
WebGLRenderingContext.prototype.glpPixelInspectorProgramsMap = {};
WebGLRenderingContext.prototype.glpProgramUniformLocations = {};
WebGLRenderingContext.prototype.glpPixelInspectorOriginalPrograms = {};
WebGLRenderingContext.prototype.glpPixelInspectorLocationMap = {};

/**
 * Applies uniform to WebGL context
 */
WebGLRenderingContext.prototype.glpApplyUniform = function applyUniform(uniform) {
    var loc = uniform.loc;
    var type = uniform.type;
    var value = uniform.value;
    if (type == this.FLOAT) {
      this.uniform1f(loc, value);
      return;
    }
    if (type == this.FLOAT_VEC2) {
      this.uniform2fv(loc, value);
      return;
    }
    if (type == this.FLOAT_VEC3) {
      this.uniform3fv(loc, value);
      return;
    }
    if (type == this.FLOAT_VEC4) {
      this.uniform4fv(loc, value);
      return;
    }
    if (type == this.INT) {
      this.uniform1i(loc, value);
      return;
    }
    if (type == this.INT_VEC2) {
      this.uniform2iv(loc, value);
      return;
    }
    if (type == this.INT_VEC3) {
      this.uniform3iv(loc, value);
      return;
    }
    if (type == this.INT_VEC4) {
      this.uniform4iv(loc, value);
      return;
    }
    if (type == this.BOOL) {
      this.uniform1i(loc, value);
      return;
    }
    if (type == this.BOOL_VEC2) {
      this.uniform2iv(loc, value);
      return;
    }
    if (type == this.BOOL_VEC3) {
      this.uniform3iv(loc, value);
      return;
    }
    if (type == this.BOOL_VEC4) {
      this.uniform4iv(loc, value);
      return;
    }
    if (type == this.FLOAT_MAT2) {
      this.uniformMatrix2fv(loc, false, value);
      return;
    }
    if (type == this.FLOAT_MAT3) {
      this.uniformMatrix3fv(loc, false, value);
      return;
    }
    if (type == this.FLOAT_MAT4) {
      this.uniformMatrix4fv(loc, false, value);
      return;
    }
    if (type == this.SAMPLER_2D || type == this.SAMPLER_CUBE) {
      this.uniform1i(loc, value);
      return;
    }
  }

/**
 * Returns the appropriate pixel inspector program
 * @param {WebGLProgram} Original Program
 * @return {WebGLProgram} Pixel Inspector Progam
 */
WebGLRenderingContext.prototype.glpGetPixelInspectorProgram = function(originalProgram) {
  if (originalProgram.__uuid in this.glpPixelInspectorProgramsMap) {
      return this.glpPixelInspectorProgramsMap[originalProgram.__uuid];
  }

  var program = this.createProgram();

  this.attachShader(program, this.glpVertexShaders[originalProgram.__uuid]);
  this.attachShader(program, this.glpGetPixelInspectFragShader());
  this.linkProgram(program);

  this.glpPixelInspectorPrograms.push(program.__uuid);
  this.glpPixelInspectorProgramsMap[originalProgram.__uuid] = program;

  return program;
}

/**
 * Enables the pixel inspector and returns the appropriate fragment shader
 * @return {WebGLShader} Pixel Inspector Shader
 */
WebGLRenderingContext.prototype.glpEnablePixelInspector = function() {
    this.glpPixelInspectorBlendProp = this.getParameter(this.BLEND);
    this.enable(this.BLEND);

    this.glpPixelInspectorBlendFuncSFactor = this.getParameter(this.BLEND_SRC_RGB);
    this.glpPixelInspectorBlendFuncDFactor = this.getParameter(this.BLEND_DST_RGB);
    this.blendFunc(this.SRC_ALPHA, this.ONE_MINUS_SRC_ALPHA);

    this.glpPixelInspectorDepthTest = this.getParameter(this.DEPTH_TEST);
    this.disable(this.DEPTH_TEST);

    this.glpPixelInspectorClearColor = this.getParameter(this.COLOR_CLEAR_VALUE);
    this.clearColor(0.0, 1.0, 0.0, 1.0);

    this.glpSwitchToPixelInspectorProgram();

    this.pixelInspectorEnabled = true;
}

/**
 * Disable the pixel inspector and returns the appropriate fragment shader
 * @return {WebGLShader} Pixel Inspector Shader
 */
WebGLRenderingContext.prototype.glpDisablePixelInspector = function() {
    if (!this.pixelInspectorEnabled) {
      return;
    }
    this.pixelInspectorEnabled = false;

    if (!this.glpPixelInspectorBlendProp) {
      this.disable(this.BLEND);
    } else {
      if (this.glpPixelInspectorBlendFuncSFactor && this.glpPixelInspectorBlendFuncDFactor) {
        this.blendFunc(this.glpPixelInspectorBlendFuncSFactor, this.glpPixelInspectorBlendFuncDFactor);
      }
    }

    if (this.glpPixelInspectorDepthTest) {
      this.enable(this.DEPTH_TEST);
    }

    if (this.glpPixelInspectorClearColor) {
      this.clearColor.apply(this, this.glpPixelInspectorClearColor);
    }

    var currentProgram = this.getParameter(this.CURRENT_PROGRAM);
    if (currentProgram.__uuid in this.glpPixelInspectorOriginalPrograms) {
      var newProgram = this.glpPixelInspectorOriginalPrograms[currentProgram.__uuid];
      this.useProgram(newProgram);
      this.glpCopyUniforms(currentProgram, newProgram);
    }
}

/**
 * Swaps the current program and copies over location and attribute data
 */
WebGLRenderingContext.prototype.glpSwitchToPixelInspectorProgram = function() {
  var oldProgram = this.getParameter(this.CURRENT_PROGRAM);
  var program = this.glpGetPixelInspectorProgram(oldProgram);

  this.useProgram(program);
  this.glpPixelInspectorOriginalPrograms[program.__uuid] = oldProgram;
  this.glpCopyUniforms(oldProgram, program);
  this.glpCopyAttributes(oldProgram, program);
  // TODO: Swap attributes!
}

/**
 * Copies uniforms from oldProgram to newProgram
 */
WebGLRenderingContext.prototype.glpCopyUniforms = function(oldProgram, program) {
  var activeUniforms = this.getProgramParameter(program, this.ACTIVE_UNIFORMS);
  this.glpPixelInspectorLocationMap[program.__uuid] = {};

  for (var i=0; i < activeUniforms; i++) {
      var uniform = this.getActiveUniform(program, i);
      var oldLocation = this.getUniformLocation(oldProgram, uniform.name);
      var newLocation = this.getUniformLocation(program, uniform.name);
      if (!oldLocation) {
        continue;
      }
      this.glpPixelInspectorLocationMap[program.__uuid][oldLocation.__uuid] = newLocation;

      uniform.loc = newLocation;
      uniform.value = this.getUniform(oldProgram, oldLocation);
      if (uniform.value != null) {
        this.glpApplyUniform(uniform);
      }
  }
}

/**
 * Copies attributes from oldProgram to newProgram
 */
WebGLRenderingContext.prototype.glpCopyAttributes = function(oldProgram, program) {
  var activeAttributes = this.getProgramParameter(oldProgram, this.ACTIVE_ATTRIBUTES);

  for (var i=0; i < activeAttributes; i++) {
      var attribute = this.getActiveAttrib(oldProgram, i);

      this.bindAttribLocation(program, attribute.index, attribute.name);
      if (attribute.size > 1) {
        this.vertexAttribPointer(attribute.index, attribute.size, attribute.type, attribute.normalized, attribute.stride, attribute.offset);
      }

      this.enableVertexAttribArray(attribute.index);
  }
}

/**
 * Returns the pixel inspector fragment shader
 * @return {WebGLShader} Pixel Inspector Fragment Shader
 */
WebGLRenderingContext.prototype.glpGetPixelInspectFragShader = function() {
    var pixelInspectFragShader = this.createShader(this.FRAGMENT_SHADER);
    var shaderStr = 'precision mediump float;' +
        'void main(void) {' +
            'gl_FragColor = vec4(1.0, 0.0, 0.0, 0.10);' +
        '}';

    this.shaderSource(pixelInspectFragShader, shaderStr);
    this.compileShader(pixelInspectFragShader);

    return pixelInspectFragShader;
}

function guid() {
  function s4() {
    return Math.floor((1 + Math.random()) * 0x10000)
      .toString(16)
      .substring(1);
  }
  return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
    s4() + '-' + s4() + s4() + s4();
}

/**
 * Returns a function that calls newFunc with origFunc and all arguments
 * @param {Function} origFunc
 * @param {Function} newFunc
 * @param {String} name of origFunc
 * @return {Function} boundFunc
 */
function _glpBind(origFunc, newFunc, name) {
    return function() {
        return newFunc.apply(this, [origFunc, arguments, name]);
    }
}

/**
 * Bind WebGLRenderingContext functions to functions found in glpFcnBindings
 * If defined, functions are first bound the function found in glpFcnBindings
 * Afterwards, they are then bound to the default func
 */
for (var name in WebGLRenderingContext.prototype) {
    try {
        if (typeof WebGLRenderingContext.prototype[name] != 'function') {
            continue;
        }

        if (glpFcnBindings[name] != null) {
            var newFunc = glpFcnBindings[name];
            WebGLRenderingContext.prototype[name] =
                _glpBind(WebGLRenderingContext.prototype[name], newFunc, name);
        }

        var defaultFunc = glpFcnBindings["default"];
        WebGLRenderingContext.prototype[name] =
            _glpBind(WebGLRenderingContext.prototype[name], defaultFunc, name);
    } catch(err) {
        if (glpVerboseLogs) {
            console.log("Binding Error: " + name)
        }
    }
}