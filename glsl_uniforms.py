import time
import comfy.utils


class GlslUniforms:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                # Dynamic frontend inputs:
                # u_tex0, u_tex1, u_val0, u_val1...
            }
        }

    CATEGORY = "GLSL"
    FUNCTION = "main"

    RETURN_TYPES = ("GLSL_CONTEXT",)
    RETURN_NAMES = ("uniforms",)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Force this lightweight wrapper to refresh.
        # Important: do NOT return True, because True == True.
        return str(time.time_ns())

    def main(self, **kwargs):
        textures = {}
        values = {}

        index = 0
        total = len(kwargs.items())
        pbar = comfy.utils.ProgressBar(total)

        for key, value in kwargs.items():
            if comfy.utils.PROGRESS_BAR_ENABLED:
                pbar.update_absolute(index + 1, total)

            if key.startswith("u_tex"):
                textures[key] = value

            elif key.startswith("u_val"):
                values[key] = value

            index += 1

        payload = {
            "__glsl_uniform_payload__": True,
            "textures": textures,
            "values": values,
            "stamp": time.time_ns(),
        }

        return (payload,)