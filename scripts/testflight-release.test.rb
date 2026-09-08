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
        query['filter[version]'] == '0.6.4' ? [{id: 'old', attributes: {version: '0.6.4', usesNonExemptEncryption: @baseline_exemption}}] : [{id: 'new', attributes: {processingState: 'VALID', expired: false, usesNonExemptEncryption: @current_exemption}}]
      when '/v1/builds/new/preReleaseVersion'
        {attributes: {version: @version, platform: 'IOS'}}
      when '/v1/betaGroups'
        [{id: 'testers', attributes: {name: 'Testers', isInternalGroup: false}}]
      when '/v1/builds/old/appEncryptionDeclaration'
        @declaration ? {id: 'crypto', attributes: {containsThirdPartyCryptography: true, containsProprietaryCryptography: false, availableOnFrenchStore: @french}} : nil
      when '/v1/builds/new/appEncryptionDeclaration'
        @current_declaration
      when '/v1/builds/new/buildBetaDetail'
        {id: 'detail', attributes: {externalBuildState: @state}}
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
end
