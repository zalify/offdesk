require 'minitest/autorun'
require_relative 'testflight-release'

class TestFlightReleaseTest < Minitest::Test
  def setup
    @writes = []
    @version = '0.6.6'
    @state = 'READY_FOR_BETA_SUBMISSION'
    @french = false
    @attached = false
    @declaration = true
    @client = lambda do |method, path, payload, query|
      if method != 'get'
        @writes << [method, path, payload]
        @state = 'WAITING_FOR_BETA_REVIEW' if path == '/v1/betaAppReviewSubmissions'
        @attached = true if path.include?('/relationships/builds')
        next {}
      end
      data = case path
      when '/v1/builds'
        query['filter[version]'] == '0.6.4' ? [{id: 'old', attributes: {version: '0.6.4', usesNonExemptEncryption: true}}] : [{id: 'new', attributes: {processingState: 'VALID', expired: false}}]
      when '/v1/builds/new/preReleaseVersion'
        {attributes: {version: @version, platform: 'IOS'}}
      when '/v1/betaGroups'
        [{id: 'testers', attributes: {name: 'Testers', isInternalGroup: false}}]
      when '/v1/builds/old/appEncryptionDeclaration'
        @declaration ? {id: 'crypto', attributes: {containsThirdPartyCryptography: true, containsProprietaryCryptography: false, availableOnFrenchStore: @french}} : nil
      when '/v1/builds/new/buildBetaDetail'
        {id: 'detail', attributes: {externalBuildState: @state}}
      when '/v1/builds/new/betaBuildLocalizations'
        [{attributes: {locale: 'en-US'}}]
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
  end

  def test_rejected_build_needs_attention
    @state = 'BETA_REJECTED'
    assert_raises(RuntimeError) { run_release }
    assert_empty @writes
  end
end
