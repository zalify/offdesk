require 'minitest/autorun'
require_relative 'testflight-release'

class TestFlightReleaseTest < Minitest::Test
  def setup
    @writes = []
    @localizations = [{attributes: {locale: 'en-US'}}]
    @version = '0.6.6'
    @state = 'READY_FOR_BETA_SUBMISSION'
    @french = false
    @attached = false
    @declaration = true
    @baseline_exemption = true
    @current_exemption = nil
    @current_declaration = nil
    @processing = ['VALID']
    @after_attach = []
    @sleeps = []
    @client = lambda do |method, path, payload, query|
      if method != 'get'
        if method == 'patch' && path == '/v1/builds/new'
          if payload.dig(:data, :attributes, :usesNonExemptEncryption) == false
            raise 'Apple rejects resetting an immutable exemption' unless @current_exemption.nil?
            @current_exemption = false
          elsif payload.dig(:data, :relationships, :appEncryptionDeclaration)
            @current_declaration = {id: 'crypto'}
          end
        end
        @writes << [method, path, payload]
        @state = 'WAITING_FOR_BETA_REVIEW' if path == '/v1/betaAppReviewSubmissions'
        @attached = true if path.include?('/relationships/builds')
        next {}
      end
      data = case path
      when '/v1/builds'
        if query['filter[version]'] == '0.6.4'
          [{id: 'old', attributes: {version: '0.6.4', usesNonExemptEncryption: @baseline_exemption}}]
        else
          # An earlier RC of another marketing version took the same build number.
          processing = @processing.length > 1 ? @processing.shift : @processing.first
          builds = {'0.6.6' => {id: 'new', attributes: {processingState: processing, expired: false, usesNonExemptEncryption: @current_exemption}},
                    '0.5.0' => {id: 'rc', attributes: {processingState: 'VALID', expired: false}}}
          wanted = query['filter[preReleaseVersion.version]']
          wanted ? builds.values_at(wanted).compact : builds.values
        end
      when '/v1/builds/new/preReleaseVersion'
        {attributes: {version: @version, platform: 'IOS'}}
      when '/v1/betaGroups'
        [{id: 'testers', attributes: {name: 'Testers', isInternalGroup: false}}]
      when '/v1/builds/old/appEncryptionDeclaration'
        @declaration ? {id: 'crypto', attributes: {containsThirdPartyCryptography: true, containsProprietaryCryptography: false, availableOnFrenchStore: @french}} : nil
      when '/v1/builds/new/appEncryptionDeclaration'
        @current_declaration
      when '/v1/builds/new/buildBetaDetail'
        # Apple can take a moment to move an attached build on.
        state = @state
        @state = @after_attach.shift if @attached && @after_attach.any?
        @state = @pre_attach.shift if !@attached && @pre_attach&.any?
        {id: 'detail', attributes: {externalBuildState: state}}
      when '/v1/builds/new/betaBuildLocalizations'
        @localizations
      when '/v1/betaGroups/testers/relationships/builds'
        @attached ? [{id: 'new'}] : []
      else
        raise "Unexpected request #{path}"
      end
      JSON.parse(JSON.generate(data: data))
    end
  end

  def run_release(apply = true)
    TestFlightRelease.new(@client, '0.6.6', '26.1', apply: apply).run
  end

  def test_preview_never_mutates
    assert_equal 'READY_FOR_BETA_SUBMISSION', run_release(false)[:externalBuildState]
    assert_empty @writes
  end

  def test_release_specific_notes_are_previewed_without_mutation
    notes = "Test multiple attachments, pairing and terminal symbols.\nChinese punctuation: ？（）"
    report = TestFlightRelease.new(@client, '0.6.6', '26.1', whats_new: notes).run
    assert_equal notes, report[:whatsNew]
    assert_empty @writes
  end

  def test_release_specific_notes_are_used_for_new_localization
    @localizations = []
    notes = 'Test multiple attachments and terminal symbols.'
    TestFlightRelease.new(@client, '0.6.6', '26.1', apply: true, whats_new: notes).run
    write = @writes.find { |_, path, _| path == '/v1/betaBuildLocalizations' }
    assert_equal notes, write[2].dig(:data, :attributes, :whatsNew)
  end

  def test_existing_notes_are_preserved
    TestFlightRelease.new(@client, '0.6.6', '26.1', apply: true, whats_new: 'New notes').run
    refute @writes.any? { |_, path, _| path.include?('betaBuildLocalizations') }
  end

  def test_wrong_marketing_version_is_rejected_before_mutation
    @version = '0.6.5'
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
  end

  def test_france_or_missing_classification_is_not_silently_changed
    @french = true
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
    @french = false
    @declaration = false
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
  end

  def test_submit_and_rerun_do_not_duplicate_review_or_group_assignment
    assert_equal 'WAITING_FOR_BETA_REVIEW', run_release[:externalBuildState]
    assert_equal 'WAITING_FOR_BETA_REVIEW', run_release[:externalBuildState]
    assert_equal 1, @writes.count { |_, path, _| path == '/v1/betaAppReviewSubmissions' }
    assert_equal 1, @writes.count { |_, path, _| path.include?('/relationships/builds') }
    assert_equal 1, @writes.count { |method, _, _| method == 'patch' }
  end

  def test_existing_exemption_is_not_written_again
    @declaration = false
    @baseline_exemption = false
    assert_equal 'WAITING_FOR_BETA_REVIEW', run_release[:externalBuildState]
    assert_equal 'WAITING_FOR_BETA_REVIEW', run_release[:externalBuildState]
    assert_equal 1, @writes.count { |method, _, _| method == 'patch' }
  end

  def test_conflicting_existing_classification_is_preserved
    @declaration = false
    @baseline_exemption = false
    @current_exemption = true
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
  end

  def test_rejected_build_needs_attention
    @state = 'BETA_REJECTED'
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
  end

  def waiting_release(**options)
    TestFlightRelease.new(@client, '0.6.6', '26.1', apply: true, interval: 30, sleeper: ->(t) { @sleeps << t }, **options)
  end

  def test_release_run_waits_for_apple_to_process_the_upload
    @processing = %w[PROCESSING PROCESSING VALID]
    assert_equal 'WAITING_FOR_BETA_REVIEW', waiting_release(wait: 600).run[:externalBuildState]
    assert_equal [30, 30], @sleeps
  end

  def test_without_wait_an_unprocessed_build_fails_at_once
    @processing = ['PROCESSING']
    error = assert_raises(RuntimeError) { waiting_release.run }
    assert_match(/not processed/, error.message)
    assert_empty @sleeps
    assert_empty @writes
  end

  def test_waiting_gives_up_after_the_limit
    @processing = ['PROCESSING']
    assert_raises(RuntimeError) { waiting_release(wait: 90).run }
    assert_equal [30, 30, 30], @sleeps
    assert_empty @writes
  end

  def test_failed_processing_is_not_waited_for
    @processing = ['FAILED']
    assert_raises(RuntimeError) { waiting_release(wait: 600).run }
    assert_empty @sleeps
  end

  def test_waits_for_the_state_after_attaching_then_submits
    @state = 'MISSING_EXPORT_COMPLIANCE'
    @after_attach = %w[MISSING_EXPORT_COMPLIANCE READY_FOR_BETA_SUBMISSION]
    assert_equal 'WAITING_FOR_BETA_REVIEW', waiting_release(wait: 600).run[:externalBuildState]
    assert_equal 1, @writes.count { |_, path, _| path == '/v1/betaAppReviewSubmissions' }
    refute_empty @sleeps
  end

  def test_notes_with_a_subject_title
    notes = "# 0.33.0: Built-in terminal and agent drafts\n\n- the Hub\n\n## Changes\n"
    text = whats_new_from_notes(notes, 'https://example.test/notes.md')
    assert_equal "Built-in terminal and agent drafts\n\nRelease notes: https://example.test/notes.md\n\n#{TestFlightRelease::TEST_PROMPT}", text
  end

  def test_notes_with_a_bare_title_use_the_first_paragraph
    notes = "# v0.33.3\n\nA node and CLI release\nfor the agent browser.\n\n## What changed\n- x\n"
    assert_equal "A node and CLI release for the agent browser.\n\n#{TestFlightRelease::TEST_PROMPT}", whats_new_from_notes(notes)
  end

  def test_notes_fit_testflight
    assert_operator whats_new_from_notes("# 1.0.0: #{'x' * 5000}").length, :<=, 4000
  end

  def test_waits_while_the_beta_state_still_reads_processing
    @state = 'PROCESSING'
    @pre_attach = %w[READY_FOR_BETA_SUBMISSION]
    assert_equal 'WAITING_FOR_BETA_REVIEW', waiting_release(wait: 600).run[:externalBuildState]
    assert_equal [30], @sleeps
  end
end
