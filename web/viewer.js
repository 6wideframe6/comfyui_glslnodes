import { app } from "../../scripts/app.js";

const ViewerId = "glslViewer";
const UniformsId = "glslUniforms";

const PLACEHOLDER_NAME = "...";
const PLACEHOLDER_TYPE = "*";

function isTextureType(type) {
    return (
        type === "IMAGE" ||
        type === "MASK" ||
        type === "OPTICAL_FLOW"
    );
}

function isValueType(type) {
    return (
        type === "INT" ||
        type === "FLOAT" ||
        type === "VEC2" ||
        type === "VEC3" ||
        type === "VEC4"
    );
}

function isDynamicInputName(name) {
    return (
        name === "uniforms" ||
        name?.startsWith("u_tex") ||
        name?.startsWith("u_val")
    );
}

function getInputLink(node, inputIndex) {
    const input = node.inputs?.[inputIndex];
    if (!input || input.link == null || !node.graph) {
        return null;
    }

    return node.graph.links?.[input.link] || null;
}

function getOriginOutputType(node, inputIndex, fallbackLinkInfo = null) {
    const linkInfo = fallbackLinkInfo || getInputLink(node, inputIndex);
    if (!linkInfo) {
        return null;
    }

    const graph = node.graph || app.graph;
    if (!graph) {
        return null;
    }

    const fromNode = graph.getNodeById(linkInfo.origin_id);
    if (!fromNode) {
        return null;
    }

    const fromOutput = fromNode.outputs?.[linkInfo.origin_slot];
    if (!fromOutput) {
        return null;
    }

    return fromOutput.type || null;
}

function getMaxSuffixIndex(node, prefix, ignoreIndex = -1) {
    let maxIndex = -1;

    if (!node.inputs) {
        return maxIndex;
    }

    for (let i = 0; i < node.inputs.length; i++) {
        if (i === ignoreIndex) {
            continue;
        }

        const name = node.inputs[i]?.name || "";
        if (!name.startsWith(prefix)) {
            continue;
        }

        const suffix = name.slice(prefix.length);
        const n = parseInt(suffix, 10);

        if (!Number.isNaN(n)) {
            maxIndex = Math.max(maxIndex, n);
        }
    }

    return maxIndex;
}

function hasUniformsInput(node, ignoreIndex = -1) {
    if (!node.inputs) {
        return false;
    }

    for (let i = 0; i < node.inputs.length; i++) {
        if (i === ignoreIndex) {
            continue;
        }

        if (node.inputs[i]?.name === "uniforms") {
            return true;
        }
    }

    return false;
}

function allocateInputName(node, fromOutputType, inputIndex) {
    if (fromOutputType === "GLSL_CONTEXT") {
        if (hasUniformsInput(node, inputIndex)) {
            return null;
        }

        return "uniforms";
    }

    if (isTextureType(fromOutputType)) {
        const nextIndex = getMaxSuffixIndex(node, "u_tex", inputIndex) + 1;
        return `u_tex${nextIndex}`;
    }

    if (isValueType(fromOutputType)) {
        const nextIndex = getMaxSuffixIndex(node, "u_val", inputIndex) + 1;
        return `u_val${nextIndex}`;
    }

    return null;
}

function convertInputInPlace(node, inputIndex, name, type) {
    const input = node.inputs?.[inputIndex];
    if (!input) {
        return false;
    }

    input.name = name;
    input.label = name;
    input.type = type;

    return true;
}

function isUnlinkedPlaceholder(input) {
    return (
        input &&
        input.name === PLACEHOLDER_NAME &&
        input.link == null
    );
}

function ensureTrailingPlaceholder(node) {
    if (!node.inputs || node.inputs.length === 0) {
        node.addInput(PLACEHOLDER_NAME, PLACEHOLDER_TYPE);
        return;
    }

    const last = node.inputs[node.inputs.length - 1];

    if (!isUnlinkedPlaceholder(last)) {
        node.addInput(PLACEHOLDER_NAME, PLACEHOLDER_TYPE);
        return;
    }

    /*
        Remove only duplicated trailing placeholders.
        This is safe because removing the last unlinked slot cannot shift
        any linked slots after it.
    */
    while (node.inputs.length >= 2) {
        const lastIndex = node.inputs.length - 1;
        const prevIndex = node.inputs.length - 2;

        const lastInput = node.inputs[lastIndex];
        const prevInput = node.inputs[prevIndex];

        if (isUnlinkedPlaceholder(lastInput) && isUnlinkedPlaceholder(prevInput)) {
            node.removeInput(lastIndex);
        } else {
            break;
        }
    }
}

function normalizeLinkedPlaceholdersAfterRestore(node) {
    if (!node.inputs) {
        return;
    }

    for (let i = 0; i < node.inputs.length; i++) {
        const input = node.inputs[i];

        if (!input || input.name !== PLACEHOLDER_NAME || input.link == null) {
            continue;
        }

        const fromOutputType = getOriginOutputType(node, i);
        if (!fromOutputType) {
            continue;
        }

        const newName = allocateInputName(node, fromOutputType, i);
        if (!newName) {
            continue;
        }

        convertInputInPlace(node, i, newName, fromOutputType);
    }
}

function markNodeDirty(node) {
    try {
        node.setDirtyCanvas?.(true, true);
    } catch (_) {}

    try {
        app.graph?.setDirtyCanvas?.(true, true);
    } catch (_) {}
}

app.registerExtension({
    name: "glslnodes.DynamicUniforms",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== ViewerId && nodeData.name !== UniformsId) {
            return;
        }

        const originalOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            this.options = this.options || {};

            const result = originalOnNodeCreated
                ? originalOnNodeCreated.apply(this, arguments)
                : undefined;

            /*
                Important:
                Do NOT remove restored inputs here.
                New node: add one placeholder.
                Restored node: onConfigure will preserve real inputs.
            */
            ensureTrailingPlaceholder(this);
            markNodeDirty(this);

            return result;
        };

        const originalOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            this.__glsl_is_configuring = true;

            const result = originalOnConfigure
                ? originalOnConfigure.apply(this, arguments)
                : undefined;

            /*
                Wait until LiteGraph/Comfy has finished restoring links.
                Then repair only placeholders, without deleting real inputs.
            */
            requestAnimationFrame(() => {
                normalizeLinkedPlaceholdersAfterRestore(this);
                ensureTrailingPlaceholder(this);
                this.__glsl_is_configuring = false;
                markNodeDirty(this);
            });

            return result;
        };

        const originalOnConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (...args) {
            const [type, index, connected, linkInfo, ioSlot] = args;

            const result = originalOnConnectionsChange
                ? originalOnConnectionsChange.apply(this, args)
                : undefined;

            if (!this.inputs || index == null || index < 0) {
                return result;
            }

            /*
                During workflow restore, avoid destructive slot edits.
                onConfigure's requestAnimationFrame repair will handle it after
                restored links exist.
            */
            if (this.__glsl_is_configuring) {
                return result;
            }

            const slot = this.inputs[index];
            if (!slot) {
                return result;
            }

            if (connected) {
                /*
                    Only the placeholder is dynamic.
                    Existing restored inputs should not be renamed.
                */
                if (slot.name !== PLACEHOLDER_NAME && ioSlot?.name !== PLACEHOLDER_NAME) {
                    return result;
                }

                const fromOutputType = getOriginOutputType(this, index, linkInfo);
                if (!fromOutputType) {
                    return result;
                }

                const newName = allocateInputName(this, fromOutputType, index);

                /*
                    Example: second GLSL_CONTEXT connection.
                    Do not destroy existing uniforms input.
                */
                if (!newName) {
                    ensureTrailingPlaceholder(this);
                    markNodeDirty(this);
                    return result;
                }

                /*
                    Critical:
                    Convert the connected placeholder in-place.
                    Do not removeInput(index).
                    Do not insert before it.
                    This preserves the active link.
                */
                convertInputInPlace(this, index, newName, fromOutputType);

                ensureTrailingPlaceholder(this);
                markNodeDirty(this);

                console.log("[glslnodes] connected dynamic input", {
                    index,
                    name: newName,
                    type: fromOutputType,
                });

                return result;
            }

            /*
                On disconnect:
                Do not aggressively remove slots.
                Removing input slots shifts indices and can break restored or
                existing connections.

                We only convert a disconnected dynamic input back into a
                placeholder if it is the last real dynamic slot before the
                trailing placeholder.
            */
            if (!connected && isDynamicInputName(slot.name)) {
                const hasLink = slot.link != null;

                if (!hasLink) {
                    slot.name = PLACEHOLDER_NAME;
                    slot.label = PLACEHOLDER_NAME;
                    slot.type = PLACEHOLDER_TYPE;

                    ensureTrailingPlaceholder(this);
                    markNodeDirty(this);

                    console.log("[glslnodes] disconnected dynamic input", {
                        index,
                    });
                }

                return result;
            }

            ensureTrailingPlaceholder(this);
            markNodeDirty(this);

            return result;
        };
    },
});