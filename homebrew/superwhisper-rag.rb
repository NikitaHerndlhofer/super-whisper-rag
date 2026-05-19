class SuperwhisperRag < Formula
  desc "Local SQL archive for your Super Whisper dictation history"
  homepage "https://github.com/USER/superwhisper-rag"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/USER/superwhisper-rag/releases/download/v0.1.0/swrag-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_FROM_sha256sums.txt"
    end
    on_intel do
      url "https://github.com/USER/superwhisper-rag/releases/download/v0.1.0/swrag-darwin-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_FROM_sha256sums.txt"
    end
  end

  # We rely on Homebrew's own SQLite for the loadable-extension build that
  # sqlite-vec needs. Ollama is recommended but not required (you can point
  # the CLI at any compatible host with --ollama-host).
  depends_on "sqlite"
  depends_on "ollama" => :recommended

  def install
    arch = Hardware::CPU.arm? ? "arm64" : "x64"
    bin.install "swrag-darwin-#{arch}" => "swrag"
  end

  def caveats
    <<~EOS
      The archive is auto-created on first use at
        ~/Library/Application Support/superwhisper-rag/swrag.sqlite

      To use semantic search:
        ollama pull bge-m3

      Optional, entirely opt-in:
        swrag enable-sync                # hourly background sync
        swrag install-skill              # ~/.cursor/skills + ~/.claude/skills
                                         # (manual-invocation only;
                                         #  @superwhisper-rag in Cursor,
                                         #  /superwhisper-rag in Claude Code)
    EOS
  end

  test do
    assert_match(/0\.1\.0/, shell_output("#{bin}/swrag --version"))
  end
end
