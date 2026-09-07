# File attachments

The existing attachment action offers **Choose photos** (photo picker) and **Choose files** (system document picker). Uploads paste the saved path into the terminal.

- Direct input sends one file, up to 25 MiB, over the existing authenticated terminal connection and pastes its saved path without pressing Enter. The submitted status means the client handed the message to the connection; verify the resulting path in the terminal. This legacy path does not have a durable delivery receipt.
- The machine stores uploads in a new private temporary directory. Client paths are reduced to a basename, control characters are removed, same-name uploads do not overwrite one another, and paths containing shell metacharacters are quoted.
- File contents are not parsed or executed by the upload handler. The terminal/agent receives paths on the machine and decides how to use them. Files live in the machine's temporary storage, not the phone's file provider.


Validation includes document-provider chooser events, binary content hashes at the actual machine, file names containing spaces and quotes, malformed-data rejection, and existing image-upload regressions. Browser tests do not replace physical iOS/Android provider testing.
