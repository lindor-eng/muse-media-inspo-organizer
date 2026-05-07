IMPORTANT: If macOS says "Muse.app is damaged and can't be opened"

This happens because the app is not yet code-signed with Apple.
To fix, open Terminal and run:

    xattr -cr /Applications/Muse.app

Then open Muse.app normally.
