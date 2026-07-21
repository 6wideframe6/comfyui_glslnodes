import moderngl
from PIL import Image

import torch
from torchvision.transforms import PILToTensor

ptt = PILToTensor()


class Buffer:
    def __init__(
        self,
        width: int,
        height: int,
        name: str = None,
        ctx=None,
    ):
        self.width = width
        self.height = height
        self.name = name
        self.ctx = ctx if ctx is not None else moderngl.get_context()

        texture = self.ctx.texture(
            (self.width, self.height),
            components=4,
        )

        self.fbo = self.ctx.framebuffer(
            color_attachments=[texture]
        )

    def bind(self):
        self.fbo.use()
        self.ctx.clear(0.0, 0.0, 0.0, 0.0)

    def use(
        self,
        index: int,
        program: moderngl.Program = None,
    ):
        self.fbo.color_attachments[0].use(index)

        if program is None:
            return

        if self.name in program:
            program[self.name] = index

        resolution_name = f"{self.name}Resolution"

        if resolution_name in program:
            program[resolution_name] = (
                float(self.width),
                float(self.height),
            )

    def getImage(self) -> Image:
        self.fbo.use()
        data = self.fbo.read(components=4)

        return Image.frombytes(
            "RGBA",
            self.fbo.size,
            data,
        )

    def getTensor(self) -> torch.Tensor:
        image = ptt(self.getImage())

        return (
            image
            .permute(1, 2, 0)
            .float()
            .mul(1.0 / 255.0)
            .flip(0)
        )


class DoubleBuffer:
    def __init__(
        self,
        width: int,
        height: int,
        name: str = None,
        ctx=None,
    ):
        self.width = width
        self.height = height
        self.name = name
        self.ctx = ctx if ctx is not None else moderngl.get_context()

        self.fbos = [
            self.ctx.framebuffer(
                color_attachments=[
                    self.ctx.texture(
                        (self.width, self.height),
                        components=4,
                    )
                ]
            ),
            self.ctx.framebuffer(
                color_attachments=[
                    self.ctx.texture(
                        (self.width, self.height),
                        components=4,
                    )
                ]
            ),
        ]

        self.index = 0

    def bind(self):
        self.index = (self.index + 1) % 2
        self.fbos[self.index].use()
        self.ctx.clear(0.0, 0.0, 0.0, 0.0)

    def use(
        self,
        index: int,
        program: moderngl.Program = None,
        prev: bool = False,
    ):
        # Current texture by default; previous ping-pong texture when requested.
        framebuffer_index = self.index

        if prev:
            framebuffer_index = (self.index + 1) % 2

        self.fbos[framebuffer_index].color_attachments[0].use(index)

        if program is None:
            return

        if self.name in program:
            program[self.name] = index

        resolution_name = f"{self.name}Resolution"

        if resolution_name in program:
            program[resolution_name] = (
                float(self.width),
                float(self.height),
            )

    def getImage(self) -> Image:
        self.fbos[self.index].use()
        data = self.fbos[self.index].read(components=4)

        return Image.frombytes(
            "RGBA",
            self.fbos[self.index].size,
            data,
        )

    def getTensor(self) -> torch.Tensor:
        image = ptt(self.getImage())

        return (
            image
            .permute(1, 2, 0)
            .float()
            .mul(1.0 / 255.0)
            .flip(0)
        )


class GlslBuffers:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "buffers": ("GLSL_BUFFERS",),
                "type": (
                    ["BUFFER", "DOUBLE_BUFFER"],
                    {"default": "BUFFER"},
                ),
                "index": ("INT", {"default": 0}),
            },
        }

    CATEGORY = "GLSL"
    FUNCTION = "main"
    RETURN_TYPES = ("IMAGE",)

    def main(
        self,
        buffers: dict,
        type: str,
        index: int,
        **kwargs,
    ):
        if type == "BUFFER":
            key = f"u_buffer{index}"

            if key not in buffers:
                return (torch.zeros(1, 1, 1, 4),)

            return (torch.cat(buffers[key], dim=0),)

        if type == "DOUBLE_BUFFER":
            key = f"u_doubleBuffer{index}"

            if key not in buffers:
                return (torch.zeros(1, 1, 1, 4),)

            return (torch.cat(buffers[key], dim=0),)

        return (torch.zeros(1, 1, 1, 4),)
