#ifndef OFFDESK_TERM_H
#define OFFDESK_TERM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct OffdeskTermHandle OffdeskTermHandle;

/* Create a new shared Rust GPU terminal engine instance. Returns NULL on failure. */
OffdeskTermHandle *offdesk_term_create(
    const char *hub_url,
    const char *token,
    const char *device_id,
    float font_size
);

/* Attach an iOS / macOS CAMetalLayer* to the shared wgpu renderer. Returns 0 on success. */
int32_t offdesk_term_attach_metal_layer(
    OffdeskTermHandle *handle,
    void *ca_metal_layer,
    uint32_t width,
    uint32_t height
);

/* Attach an Android ANativeWindow* to the shared wgpu renderer. Returns 0 on success. */
int32_t offdesk_term_attach_android_window(
    OffdeskTermHandle *handle,
    void *anative_window,
    uint32_t width,
    uint32_t height
);

/* Resize the GPU surface and propagate (cols, rows) to the active terminal. */
int32_t offdesk_term_resize(OffdeskTermHandle *handle, uint32_t width, uint32_t height);

/* Select (and lazily connect) a terminal by (machine_id, terminal_id). */
int32_t offdesk_term_select_terminal(
    OffdeskTermHandle *handle,
    const char *machine_id,
    const char *terminal_id
);

/* Send raw UTF-8 / control bytes to the active terminal. */
int32_t offdesk_term_send_input(OffdeskTermHandle *handle, const uint8_t *data, size_t len);

/* Scroll local 10,000-line GPU scrollback (positive = up, negative = down). */
int32_t offdesk_term_scroll(OffdeskTermHandle *handle, int32_t delta_lines);

/* Drain pending WebSocket bytes and present one GPU frame. */
int32_t offdesk_term_render(OffdeskTermHandle *handle);

/* Return a UTF-8 JSON snapshot of machines & terminals. Free with offdesk_term_free_string. */
char *offdesk_term_get_inventory_json(OffdeskTermHandle *handle);

/* Free a string allocated by offdesk_term_get_inventory_json. */
void offdesk_term_free_string(char *ptr);

/* Destroy the handle and release all GPU and network resources. */
void offdesk_term_destroy(OffdeskTermHandle *handle);

#ifdef __cplusplus
}
#endif

#endif /* OFFDESK_TERM_H */
